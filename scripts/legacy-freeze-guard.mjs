#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { kill } from 'node:process'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { basename, dirname, isAbsolute, parse, relative, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCHEMA = 'video-autoworker-legacy-freeze-guard/v1'
const scriptPath = realpathSync(fileURLToPath(import.meta.url))
const managedBootstrapControllerPath = join(dirname(scriptPath), 'legacy-bootstrap-controller.mjs')
const SHA256 = /^[a-f0-9]{64}$/u
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_FREEZE === '1'

function fail(message) { throw new Error(`legacy freeze guard failed: ${message}`) }
function bootstrapControllerPath() {
  const override = process.env.AIWORKER_TEST_LEGACY_FREEZE_BOOTSTRAP_CONTROLLER
  if (override !== undefined) {
    if (!TEST_MODE) fail('bootstrap resume controller override is forbidden outside isolated test mode')
    absolute(override, 'test bootstrap resume controller')
    return override
  }
  return managedBootstrapControllerPath
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} fields are invalid`)
  }
}
function absolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}
function noSymlink(pathname, label) {
  absolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current) } catch { fail(`${label} path component is unavailable`) }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}
function safeEntry(pathname, label, kind, mode = null) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if ((kind === 'file' && !entry.isFile()) || (kind === 'directory' && !entry.isDirectory())
    || (kind === 'socket' && !entry.isSocket())) fail(`${label} type is invalid`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actual = Number(entry.mode & 0o7777n)
  if (mode === null ? (actual & 0o022) !== 0 : actual !== mode) fail(`${label} mode is unsafe`)
  return entry
}
function identity(pathname, label, kind = 'file', mode = null) {
  const entry = safeEntry(pathname, label, kind, mode)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}
function parseLsof(source) {
  const records = []
  let current
  for (const line of source.split('\n')) {
    if (line[0] === 'f') { current = { descriptor: line.slice(1) }; records.push(current) }
    else if (current && line[0] === 'D') current.dev = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'i') current.ino = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'n') current.path = line.slice(1)
  }
  return records
}
function run(command, args, label) {
  try { return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) }
  catch { fail(`${label} failed`) }
}
function processBinding(pid, databases, socketPath) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('guard PID is invalid')
  const records = parseLsof(run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-FfDin'], 'guard FD query'))
  for (const [label, database] of Object.entries(databases)) {
    const dbMatches = records.filter(item => /^\d+[A-Za-z]*$/u.test(item.descriptor || '')
      && item.path === database.path && item.dev === database.dev && item.ino === database.ino)
    if (!dbMatches.length) fail(`guard PID is not holding the authoritative ${label} database FD`)
  }
  if (!records.some(item => item.path === socketPath)) fail('guard PID is not bound to the private socket')
  const nodeText = records.filter(item => item.descriptor === 'txt' && /\/bin\/node$/u.test(item.path || ''))
  if (nodeText.length !== 1) fail('guard PID does not have exactly one Node executable mapping')
  const argv = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], 'guard argv query').trim()
  const uid = Number(run('/bin/ps', ['-p', String(pid), '-o', 'uid='], 'guard uid query').trim())
  const startedAt = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 'guard start query').trim()
  if (uid !== process.getuid() || !argv.includes(scriptPath) || !/(^|\s)serve(?:-recovery)?(\s|$)/u.test(argv)) {
    fail('guard process command identity is invalid')
  }
  return { argvSha256: sha256(argv), startedAt }
}
function legacyBinding(pid, database) {
  const listeners = [...new Set(run('/usr/sbin/lsof', [
    '-nP', '-iTCP:3017', '-sTCP:LISTEN', '-Fp',
  ], 'legacy listener query').split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
  if (listeners.length !== 1 || listeners[0] !== pid) fail('legacy PID is not the sole 3017 listener')
  const records = parseLsof(run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-FfDin'], 'legacy FD query'))
  if (!records.some(item => /^\d+[A-Za-z]*$/u.test(item.descriptor || '')
    && item.path === database.path && item.dev === database.dev && item.ino === database.ino)) {
    fail('legacy PID is not holding the authoritative database FD')
  }
  const nodeText = records.filter(item => item.descriptor === 'txt' && /\/bin\/node$/u.test(item.path || ''))
  if (nodeText.length !== 1) fail('legacy PID does not have exactly one Node executable mapping')
  const uid = Number(run('/bin/ps', ['-p', String(pid), '-o', 'uid='], 'legacy uid query').trim())
  const startedAt = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 'legacy start query').trim()
  const argv = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], 'legacy argv query').trim()
  if (uid !== process.getuid() || !startedAt || !argv) fail('legacy process identity is invalid')
  return { pid, uid, startedAt, argvSha256: sha256(argv), database, port: 3017 }
}
function readPrivate(pathname, label) {
  const entry = safeEntry(pathname, label, 'file', 0o600)
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1n) fail(`${label} identity changed`)
    const result = Buffer.alloc(Number(opened.size))
    if (readSync(fd, result, 0, result.length, 0) !== result.length) fail(`${label} short read`)
    return result
  } finally { closeSync(fd) }
}
function parseArgs(argv) {
  const command = argv[0]
  const values = {}
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || Object.hasOwn(values, argv[i])) fail('arguments are invalid')
    values[argv[i]] = argv[i + 1]
  }
  return { command, values }
}
function requirePaths(values, names) {
  for (const name of names) {
    if (!values[name]) fail(`${name} is required`)
    absolute(values[name], name)
  }
}
function requireSocketPath(pathname) {
  if (Buffer.byteLength(pathname) > 100) fail('guard socket path is too long for a Unix socket')
}
function writeExclusive(pathname, source) {
  let fd
  let created = false
  try {
    fd = openSync(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    created = true
    const buffer = Buffer.from(source)
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    const parentFd = openSync(dirname(pathname), constants.O_RDONLY)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd) } catch {}
    if (created) { try { unlinkSync(pathname) } catch {} }
    throw error
  }
}

function replacePrivate(pathname, expected, source) {
  const current = readPrivate(pathname, 'guard token')
  if (current.length !== expected.length || !timingSafeEqual(current, expected)) {
    fail('guard token changed during startup')
  }
  const temporary = join(dirname(pathname), `.${basename(pathname)}.${randomBytes(16).toString('hex')}.tmp`)
  try {
    writeExclusive(temporary, source)
    renameSync(temporary, pathname)
    const parentFd = openSync(dirname(pathname), constants.O_RDONLY)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}
async function exchange(socketPath, payload) {
  requireSocketPath(socketPath)
  safeEntry(dirname(socketPath), 'guard socket directory', 'directory', 0o700)
  safeEntry(socketPath, 'guard socket', 'socket', 0o600)
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath })
    let source = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('guard response timed out')) }, 5000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', chunk => {
      source += chunk
      if (source.length > 8192) socket.destroy(new Error('guard response is too large'))
      if (source.includes('\n')) socket.end()
    })
    socket.on('error', reject)
    socket.on('close', () => {
      clearTimeout(timer)
      try { resolvePromise(JSON.parse(source.trim())) } catch { reject(new Error('guard response is invalid')) }
    })
  })
}
export async function attestGuard(socketPath, expectedDatabases = null, allowExpired = false) {
  const challenge = randomBytes(32).toString('hex')
  const value = await exchange(socketPath, { action: 'attest', challenge })
  exactKeys(value, ['argvSha256', 'challenge', 'database', 'expiresAt', 'guardNonceSha256',
    'issuedAt', 'legacyBindingSha256', 'mode', 'n8nDatabase', 'pid', 'ready', 'schema', 'scriptSha256', 'socket',
    'startedAt', 'uid'], 'guard attestation')
  exactKeys(value.database, ['dev', 'ino', 'path'], 'guard database')
  exactKeys(value.n8nDatabase, ['dev', 'ino', 'path'], 'guard n8n database')
  exactKeys(value.socket, ['dev', 'ino', 'path'], 'guard socket')
  if (value.schema !== SCHEMA || value.ready !== true || value.challenge !== challenge
    || !['dual', 'dual-recovery', 'recovery-hold'].includes(value.mode)
    || value.uid !== process.getuid()
    || !SHA256.test(value.guardNonceSha256) || !SHA256.test(value.scriptSha256)
    || value.scriptSha256 !== sha256(readFileSync(scriptPath)) || !SHA256.test(value.argvSha256)
    || !SHA256.test(value.legacyBindingSha256)
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt > Math.floor(Date.now() / 1000)
    || (!allowExpired && value.expiresAt < Math.floor(Date.now() / 1000))
    || value.expiresAt - value.issuedAt < 30 || value.expiresAt - value.issuedAt > 1800) {
    fail('guard attestation contract is invalid')
  }
  const socketIdentity = identity(socketPath, 'guard socket', 'socket', 0o600)
  if (JSON.stringify(value.socket) !== JSON.stringify(socketIdentity)) fail('guard socket identity changed')
  if (expectedDatabases && (JSON.stringify(value.database) !== JSON.stringify(expectedDatabases.mission)
    || JSON.stringify(value.n8nDatabase) !== JSON.stringify(expectedDatabases.n8n))) {
    fail('guard databases do not match the authoritative databases')
  }
  const binding = processBinding(value.pid, {
    'Mission Control': value.database,
    n8n: value.n8nDatabase,
  }, socketPath)
  if (binding.argvSha256 !== value.argvSha256 || binding.startedAt !== value.startedAt) {
    fail('guard process identity changed')
  }
  return value
}
function verifyResumeCapability(command, values) {
  requirePaths(values, ['--resume-receipt', '--resume-token'])
  const controllerPath = bootstrapControllerPath()
  safeEntry(controllerPath, 'bootstrap resume controller', 'file')
  const environment = { ...process.env }
  if (!TEST_MODE) {
    environment.NODE_ENV = 'production'
    for (const name of Object.keys(environment)) {
      if (name.startsWith('AIWORKER_TEST_')) delete environment[name]
    }
  }
  const result = execFileSync(process.execPath, [
    controllerPath, command,
    '--receipt', values['--resume-receipt'],
    '--token', values['--resume-token'],
  ], { encoding: 'utf8', env: environment, maxBuffer: 1024 * 1024 })
  let response
  try { response = JSON.parse(result) } catch { fail('bootstrap resume controller response is invalid') }
  exactKeys(response, command === 'consume-bootstrap-resume'
    ? ['consumed', 'databases', 'expiresAt', 'mode']
    : ['databases', 'expiresAt', 'mode'], 'bootstrap resume controller response')
  if (response.mode !== command || !Number.isSafeInteger(response.expiresAt)) {
    fail('bootstrap resume controller returned another operation')
  }
  exactKeys(response.databases, ['mission', 'n8n'], 'bootstrap resume databases')
  return response
}

async function serve(values, recovery = false) {
  requirePaths(values, ['--database', '--n8n-database', '--socket', '--token-file'])
  requireSocketPath(values['--socket'])
  const legacyPid = recovery ? null : Number(values['--legacy-pid'])
  if (!recovery && (!Number.isSafeInteger(legacyPid) || legacyPid <= 0)) fail('--legacy-pid is required')
  const ttl = Number(values['--ttl-seconds'])
  if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 1800) fail('--ttl-seconds must be between 30 and 1800')
  const database = identity(values['--database'], 'guard database')
  const n8nDatabase = identity(values['--n8n-database'], 'guard n8n database')
  if (database.path === n8nDatabase.path
    || (database.dev === n8nDatabase.dev && database.ino === n8nDatabase.ino)) {
    fail('Mission Control and n8n databases must be distinct physical files')
  }
  safeEntry(dirname(values['--socket']), 'guard state directory', 'directory', 0o700)
  if (existsSync(values['--socket']) || existsSync(values['--token-file'])) fail('guard socket or token already exists')
  if (dirname(values['--socket']) !== dirname(values['--token-file'])) fail('guard socket and token must share one directory')
  const resumeBefore = recovery ? verifyResumeCapability('verify-bootstrap-resume', values) : null
  if (resumeBefore && (canonicalJson(resumeBefore.databases.mission) !== canonicalJson(database)
    || canonicalJson(resumeBefore.databases.n8n) !== canonicalJson(n8nDatabase))) {
    fail('bootstrap resume capability is bound to other databases')
  }
  const legacyBefore = recovery ? null : legacyBinding(legacyPid, database)
  const scopedRequire = createRequire(import.meta.url)
  const Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [realpathSync(join(dirname(scriptPath), '..'))] }))
  const db = new Database(database.path, { fileMustExist: true, timeout: 30000 })
  const n8nDb = new Database(n8nDatabase.path, { fileMustExist: true, timeout: 30000 })
  db.pragma('busy_timeout = 30000')
  n8nDb.pragma('busy_timeout = 30000')
  if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('guard database quick_check failed')
  if (n8nDb.pragma('quick_check', { simple: true }) !== 'ok') fail('guard n8n database quick_check failed')
  try {
    // All production code acquires cross-database maintenance reservations in
    // this fixed order. Holding both locks closes the gap between the two
    // online backups without stopping either reader process.
    db.exec('BEGIN IMMEDIATE')
    n8nDb.exec('BEGIN IMMEDIATE')
  } catch (error) {
    try { n8nDb.exec('ROLLBACK') } catch {}
    try { db.exec('ROLLBACK') } catch {}
    try { n8nDb.close() } catch {}
    try { db.close() } catch {}
    throw error
  }
  const resumeAfterLock = recovery ? verifyResumeCapability('verify-bootstrap-resume', values) : null
  if (resumeAfterLock && (canonicalJson(resumeAfterLock.databases) !== canonicalJson(resumeBefore.databases)
    || resumeAfterLock.expiresAt !== resumeBefore.expiresAt)) {
    try { n8nDb.exec('ROLLBACK') } catch {}
    try { db.exec('ROLLBACK') } catch {}
    try { n8nDb.close() } catch {}
    try { db.close() } catch {}
    fail('bootstrap resume capability changed while acquiring the writer reservation')
  }
  const legacyAfterLock = recovery ? null : legacyBinding(legacyPid, database)
  if (!recovery && canonicalJson(legacyBefore) !== canonicalJson(legacyAfterLock)) {
    try { n8nDb.exec('ROLLBACK') } catch {}
    try { db.exec('ROLLBACK') } catch {}
    try { n8nDb.close() } catch {}
    try { db.close() } catch {}
    fail('legacy identity changed while acquiring the writer reservation')
  }
  const legacyBindingSha256 = recovery
    ? sha256(canonicalJson({ receipt: values['--resume-receipt'], expiresAt: resumeAfterLock.expiresAt }))
    : sha256(canonicalJson(legacyAfterLock))
  const token = randomBytes(32)
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + ttl
  const startingToken = JSON.stringify({
    schema: SCHEMA, token: token.toString('hex'), pid: process.pid, uid: process.getuid(),
    database, n8nDatabase, socket: values['--socket'], scriptSha256: sha256(readFileSync(scriptPath)),
    issuedAt, expiresAt, state: 'starting', socketIdentity: null,
    ownerStartTime: null, ownerArgvSha256: null,
  })
  try { writeExclusive(values['--token-file'], startingToken) } catch (error) {
    try { n8nDb.exec('ROLLBACK') } catch {}
    try { db.exec('ROLLBACK') } catch {}
    try { n8nDb.close() } catch {}
    try { db.close() } catch {}
    throw error
  }
  const nonceHash = sha256(token)
  const server = createServer()
  const sockets = new Set()
  let released = false
  let ready = false
  let mode = recovery ? 'dual-recovery' : 'dual'
  let expiryTimer
  const cleanup = () => {
    if (released) return
    released = true
    if (expiryTimer) clearTimeout(expiryTimer)
    try { n8nDb.exec('ROLLBACK') } catch {}
    try { db.exec('ROLLBACK') } catch {}
    try { n8nDb.close() } catch {}
    try { db.close() } catch {}
    try { unlinkSync(values['--socket']) } catch {}
    try { unlinkSync(values['--token-file']) } catch {}
  }
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let source = ''
    socket.on('data', chunk => {
      source += chunk
      if (source.length > 4096) socket.destroy()
      if (!source.includes('\n')) return
      if (!ready) { socket.end('{"error":"not_ready"}\n'); return }
      let request
      try { request = JSON.parse(source.trim()) } catch { socket.end('{"error":"invalid_request"}\n'); return }
      if (!request || !SHA256.test(request.challenge)) { socket.end('{"error":"invalid_challenge"}\n'); return }
      if (request.action === 'attest') {
        const socketIdentity = identity(values['--socket'], 'guard socket', 'socket', 0o600)
        const binding = processBinding(process.pid, {
          'Mission Control': database,
          n8n: n8nDatabase,
        }, values['--socket'])
        socket.end(`${JSON.stringify({ schema: SCHEMA, ready: true, challenge: request.challenge, pid: process.pid,
          uid: process.getuid(), startedAt: binding.startedAt, argvSha256: binding.argvSha256,
          scriptSha256: sha256(readFileSync(scriptPath)), guardNonceSha256: nonceHash,
          issuedAt, expiresAt, legacyBindingSha256, mode,
          database, n8nDatabase, socket: socketIdentity })}\n`)
      } else if (request.action === 'handoff') {
        let candidate
        try { candidate = Buffer.from(request.token, 'hex') } catch { candidate = Buffer.alloc(0) }
        if (candidate.length !== token.length || !timingSafeEqual(candidate, token)) {
          socket.end('{"error":"invalid_token"}\n'); return
        }
        if (!['dual', 'dual-recovery'].includes(mode)) { socket.end('{"error":"already_handed_off"}\n'); return }
        try {
          db.exec('ROLLBACK')
          mode = 'recovery-hold'
          socket.end('{"recoveryHold":true}\n')
        } catch {
          socket.end('{"error":"mission_release_failed"}\n')
        }
      } else if (request.action === 'revoke') {
        let candidate
        try { candidate = Buffer.from(request.token, 'hex') } catch { candidate = Buffer.alloc(0) }
        if (candidate.length !== token.length || !timingSafeEqual(candidate, token)) {
          socket.end('{"error":"invalid_token"}\n'); return
        }
        socket.end('{"released":true}\n', () => server.close(cleanup))
      } else socket.end('{"error":"invalid_action"}\n')
    })
  })
  const stop = () => {
    try { server.close() } catch {}
    for (const socket of sockets) socket.destroy()
    cleanup()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const startingBoundToken = await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(values['--socket'], () => {
        try {
          chmodSync(values['--socket'], 0o600)
          const socketIdentity = identity(values['--socket'], 'guard socket', 'socket', 0o600)
          const boundToken = JSON.stringify({
            schema: SCHEMA, token: token.toString('hex'), pid: process.pid, uid: process.getuid(),
            database, n8nDatabase, socket: values['--socket'], scriptSha256: sha256(readFileSync(scriptPath)),
            issuedAt, expiresAt, state: 'starting-bound', socketIdentity,
            ownerStartTime: null, ownerArgvSha256: null,
          })
          replacePrivate(values['--token-file'], Buffer.from(startingToken), boundToken)
          resolvePromise(boundToken)
        } catch (error) { reject(error) }
      })
    })
    const readyDelay = TEST_MODE
      ? Number(process.env.AIWORKER_TEST_LEGACY_FREEZE_READY_DELAY_MS || 0) : 0
    if (!Number.isSafeInteger(readyDelay) || readyDelay < 0 || readyDelay > 5000) {
      fail('test ready delay is invalid')
    }
    if (readyDelay) await new Promise(resolvePromise => setTimeout(resolvePromise, readyDelay))
    const socketIdentity = identity(values['--socket'], 'guard socket', 'socket', 0o600)
    const owner = processBinding(process.pid, {
      'Mission Control': database,
      n8n: n8nDatabase,
    }, values['--socket'])
    const readyToken = JSON.stringify({
      schema: SCHEMA, token: token.toString('hex'), pid: process.pid, uid: process.getuid(),
      database, n8nDatabase, socket: values['--socket'], scriptSha256: sha256(readFileSync(scriptPath)),
      issuedAt, expiresAt, state: 'ready', socketIdentity,
      ownerStartTime: owner.startedAt, ownerArgvSha256: owner.argvSha256,
    })
    replacePrivate(values['--token-file'], Buffer.from(startingBoundToken), readyToken)
    if (recovery) {
      const consumed = verifyResumeCapability('consume-bootstrap-resume', values)
      if (canonicalJson(consumed.databases) !== canonicalJson(resumeBefore.databases)
        || consumed.expiresAt !== resumeBefore.expiresAt) {
        fail('bootstrap resume consumption changed its authorized databases')
      }
    }
    ready = true
    expiryTimer = setTimeout(stop, Math.max(1, expiresAt * 1000 - Date.now()))
  } catch (error) {
    cleanup()
    throw error
  }
  process.stdout.write(`Legacy freeze guard active: pid=${process.pid}\n`)
}
async function statusOrRevoke(command, values) {
  requirePaths(values, ['--socket', '--database', '--n8n-database'])
  const expected = {
    mission: identity(values['--database'], 'expected database'),
    n8n: identity(values['--n8n-database'], 'expected n8n database'),
  }
  const attestation = await attestGuard(values['--socket'], expected, command === 'revoke')
  if (command === 'status') { process.stdout.write(`${JSON.stringify(attestation)}\n`); return }
  requirePaths(values, ['--token-file'])
  let tokenState
  try { tokenState = JSON.parse(readPrivate(values['--token-file'], 'guard token').toString('utf8')) }
  catch { fail('guard token is invalid') }
  exactKeys(tokenState, [
    'database', 'expiresAt', 'issuedAt', 'n8nDatabase', 'ownerArgvSha256', 'ownerStartTime', 'pid', 'schema',
    'scriptSha256', 'socket', 'socketIdentity', 'state', 'token', 'uid',
  ], 'guard token')
  if (tokenState.schema !== SCHEMA || tokenState.state !== 'ready'
    || tokenState.pid !== attestation.pid
    || tokenState.uid !== process.getuid() || tokenState.socket !== values['--socket']
    || JSON.stringify(tokenState.database) !== JSON.stringify(attestation.database)
    || JSON.stringify(tokenState.n8nDatabase) !== JSON.stringify(attestation.n8nDatabase)
    || tokenState.scriptSha256 !== attestation.scriptSha256
    || tokenState.ownerStartTime !== attestation.startedAt
    || tokenState.ownerArgvSha256 !== attestation.argvSha256
    || JSON.stringify(tokenState.socketIdentity) !== JSON.stringify(attestation.socket)
    || tokenState.issuedAt !== attestation.issuedAt || tokenState.expiresAt !== attestation.expiresAt
    || !SHA256.test(tokenState.token)
    || sha256(Buffer.from(tokenState.token, 'hex')) !== attestation.guardNonceSha256) fail('guard token is invalid')
  const challenge = randomBytes(32).toString('hex')
  const action = command === 'handoff' ? 'handoff' : 'revoke'
  if (action === 'handoff' && !['dual', 'dual-recovery'].includes(attestation.mode)) {
    fail('guard is not holding both databases before handoff')
  }
  const response = await exchange(values['--socket'], { action, challenge, token: tokenState.token })
  if (action === 'handoff') {
    if (response?.recoveryHold !== true) fail('guard did not enter the n8n recovery hold')
    process.stdout.write('Legacy freeze guard entered n8n recovery hold\n')
    return
  }
  if (response?.released !== true) fail('guard did not acknowledge release')
  process.stdout.write('Legacy freeze guard released\n')
}
function recoverStale(values) {
  requirePaths(values, ['--socket', '--token-file', '--database', '--n8n-database'])
  safeEntry(dirname(values['--socket']), 'guard state directory', 'directory', 0o700)
  if (dirname(values['--socket']) !== dirname(values['--token-file'])) fail('guard socket and token must share one directory')
  let tokenState
  try { tokenState = JSON.parse(readPrivate(values['--token-file'], 'stale guard token').toString('utf8')) }
  catch { fail('stale guard token is invalid') }
  exactKeys(tokenState, [
    'database', 'expiresAt', 'issuedAt', 'n8nDatabase', 'ownerArgvSha256', 'ownerStartTime', 'pid', 'schema',
    'scriptSha256', 'socket', 'socketIdentity', 'state', 'token', 'uid',
  ], 'stale guard token')
  const database = identity(values['--database'], 'expected database')
  const n8nDatabase = identity(values['--n8n-database'], 'expected n8n database')
  if (tokenState.schema !== SCHEMA || tokenState.uid !== process.getuid()
    || tokenState.socket !== values['--socket'] || !SHA256.test(tokenState.token)
    || tokenState.scriptSha256 !== sha256(readFileSync(scriptPath))
    || JSON.stringify(tokenState.database) !== JSON.stringify(database)
    || JSON.stringify(tokenState.n8nDatabase) !== JSON.stringify(n8nDatabase)
    || !Number.isSafeInteger(tokenState.pid) || tokenState.pid <= 0
    || !['starting', 'starting-bound', 'ready'].includes(tokenState.state)
    || (tokenState.state === 'starting' && (tokenState.socketIdentity !== null
      || tokenState.ownerStartTime !== null || tokenState.ownerArgvSha256 !== null))
    || (tokenState.state === 'starting-bound' && (!tokenState.socketIdentity
      || tokenState.ownerStartTime !== null || tokenState.ownerArgvSha256 !== null))
    || (tokenState.state === 'ready' && (!tokenState.socketIdentity
      || typeof tokenState.ownerStartTime !== 'string' || !tokenState.ownerStartTime
      || !SHA256.test(tokenState.ownerArgvSha256)))) {
    fail('stale guard state is not owned by this controller')
  }
  try { kill(tokenState.pid, 0); fail('guard PID is still alive; use revoke') } catch (error) {
    if (error?.message?.includes('still alive')) throw error
    if (error?.code !== 'ESRCH') fail('unable to prove stale guard PID is absent')
  }
  if (existsSync(values['--socket'])) {
    const socketIdentity = identity(values['--socket'], 'stale guard socket', 'socket', 0o600)
    if (!['starting-bound', 'ready'].includes(tokenState.state)
      || JSON.stringify(socketIdentity) !== JSON.stringify(tokenState.socketIdentity)) {
      fail('stale guard socket is not bound to the dead recorded owner')
    }
  }
  if (existsSync(values['--socket'])) unlinkSync(values['--socket'])
  unlinkSync(values['--token-file'])
  process.stdout.write('Recovered stale legacy freeze guard state\n')
}
async function main() {
  const { command, values } = parseArgs(process.argv.slice(2))
  if (command === 'serve') return serve(values)
  if (command === 'serve-recovery') return serve(values, true)
  if (command === 'status' || command === 'handoff' || command === 'revoke') return statusOrRevoke(command, values)
  if (command === 'recover-stale') return recoverStale(values)
  fail('expected serve, serve-recovery, status, handoff, revoke, or recover-stale')
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
