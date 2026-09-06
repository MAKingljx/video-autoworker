#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { get } from 'node:http'
import { once } from 'node:events'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const N8N_COMPLETE_STARTUP_WITNESS_SCHEMA =
  'video-autoworker-n8n-complete-startup-witness/v1'
const N8N_VERSION = '2.31.6'
const COMPLETION_LABEL = 'Editor is now accessible via:'
const MANAGED_WORKFLOW_FILES = Object.freeze([
  'aiworker-task-intake.json',
  'aiworker-video-analysis.json',
])
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_WITNESS_BYTES = 16 * 1024
const MAX_PENDING_STDOUT_BYTES = 64 * 1024
const scriptPath = realpathSync(fileURLToPath(import.meta.url))

export function managedN8nStartupWitnessPath() {
  const override = process.env.AIWORKER_TEST_N8N_STARTUP_WITNESS
  if (override !== undefined) {
    if (process.env.NODE_ENV !== 'test' || process.env.AIWORKER_TEST_N8N_IDENTITY !== '1') {
      fail('startup witness override is forbidden outside isolated tests')
    }
    return normalizedAbsolute(override, 'test n8n startup witness')
  }
  return join(userInfo().homedir, 'ai-worker/run/n8n/n8n.complete-ready.json')
}

function fail(message) { throw new Error(`n8n startup witness failed: ${message}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}
function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
  return pathname
}
function noSymlink(pathname, label, allowMissingLeaf = false) {
  const root = parse(normalizedAbsolute(pathname, label)).root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    let entry
    try { entry = lstatSync(current) } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}
function safeEntry(pathname, label, kind, mode = null) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if ((kind === 'file' && (!entry.isFile() || entry.nlink !== 1n))
    || (kind === 'directory' && !entry.isDirectory())) fail(`${label} type is invalid`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actualMode = Number(entry.mode & 0o7777n)
  if (mode === null ? (actualMode & 0o022) !== 0 : actualMode !== mode) fail(`${label} mode is unsafe`)
  return entry
}
function readStable(pathname, label, mode = null, maximumBytes = MAX_WITNESS_BYTES) {
  const entry = safeEntry(pathname, label, 'file', mode)
  if (entry.size <= 0n || entry.size > BigInt(maximumBytes)) fail(`${label} size is invalid`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before read`)
    const source = Buffer.alloc(Number(opened.size))
    if (readSync(descriptor, source, 0, source.length, 0) !== source.length) fail(`${label} short read`)
    const after = lstatSync(pathname, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.nlink !== 1n) fail(`${label} changed during read`)
    return source
  } finally { closeSync(descriptor) }
}
function fileIdentity(pathname, label) {
  normalizedAbsolute(pathname, label)
  let physical
  try { physical = realpathSync(pathname) } catch { fail(`${label} is unavailable`) }
  noSymlink(physical, `${label} physical path`)
  const entry = statSync(physical, { bigint: true })
  if (!entry.isFile() || entry.uid !== BigInt(process.getuid()) || (entry.mode & 0o022n) !== 0n) {
    fail(`${label} is not one controlled file`)
  }
  return { path: physical, dev: entry.dev.toString(), ino: entry.ino.toString() }
}
function directoryIdentity(pathname, label) {
  noSymlink(pathname, label)
  const physical = realpathSync(pathname)
  const entry = statSync(physical, { bigint: true })
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid()) || (entry.mode & 0o022n) !== 0n) {
    fail(`${label} is not one controlled directory`)
  }
  return { path: physical, dev: entry.dev.toString(), ino: entry.ino.toString() }
}
function readPid(pathname) {
  const source = readStable(pathname, 'n8n PID file', 0o600, 64).toString('utf8').trim()
  if (!/^[1-9][0-9]*$/u.test(source) || !Number.isSafeInteger(Number(source))) {
    fail('n8n PID file is invalid')
  }
  return Number(source)
}
function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000 }).trim()
  } catch { fail(`${label} failed`) }
}
function processIdentity(pid, node, cli) {
  try { process.kill(pid, 0) } catch { fail('n8n child PID is not running') }
  const uid = Number(run('/bin/ps', ['-p', String(pid), '-o', 'uid='], 'n8n child uid query'))
  const startToken = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 'n8n child start query')
  const argv = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], 'n8n child argv query')
  const parts = argv.split(/\s+/u)
  if (uid !== process.getuid() || parts.length !== 3 || parts[2] !== 'start'
    || realpathSync(parts[0]) !== node.path || realpathSync(parts[1]) !== cli.path) {
    fail('n8n child command identity is invalid')
  }
  return { pid, uid, startToken, argvSha256: sha256(argv) }
}
function runtimeIdentity(runtimeRoot) {
  const runtime = directoryIdentity(runtimeRoot, 'n8n runtime root')
  if (runtime.path !== runtimeRoot || !COMMIT.test(basename(runtime.path))) {
    fail('n8n runtime root is not one immutable commit release')
  }
  const commit = readStable(join(runtime.path, 'SOURCE_COMMIT'), 'n8n runtime SOURCE_COMMIT', 0o600, 64)
    .toString('utf8')
  if (commit !== `${basename(runtime.path)}\n`) fail('n8n runtime SOURCE_COMMIT changed')
  return { ...runtime, sourceCommit: commit.trim() }
}
function n8nVersion(runtime) {
  let value
  try {
    value = JSON.parse(readStable(
      join(runtime.path, 'ops/n8n/node_modules/n8n/package.json'),
      'n8n package metadata',
      null,
      1024 * 1024,
    ).toString('utf8'))
  } catch { fail('n8n package metadata is invalid') }
  if (value?.version !== N8N_VERSION) fail(`n8n package version is not ${N8N_VERSION}`)
  return value.version
}
function managedWorkflowIds(runtime) {
  const ids = MANAGED_WORKFLOW_FILES.map(file => {
    let value
    try {
      value = JSON.parse(readStable(
        join(runtime.path, 'ops/n8n/workflows', file),
        `managed workflow ${file}`,
        0o600,
        1024 * 1024,
      ).toString('utf8'))
    } catch { fail(`managed workflow ${file} is invalid`) }
    if (typeof value?.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(value.id)) {
      fail(`managed workflow ${file} has an invalid ID`)
    }
    return value.id
  })
  if (new Set(ids).size !== ids.length) fail('managed workflow IDs are not unique')
  return ids.sort()
}
function loopbackOrigin(value, label) {
  let url
  try { url = new URL(value) } catch { fail(`${label} is invalid`) }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '5678' || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    fail(`${label} is not the managed loopback origin`)
  }
  return 'http://127.0.0.1:5678'
}
function captureBinding(values, expectedChild = null) {
  const runtime = runtimeIdentity(values['--runtime-root'])
  const node = fileIdentity(values['--node-bin'], 'n8n Node executable')
  const cli = fileIdentity(values['--cli'], 'n8n CLI')
  const expectedCli = join(runtime.path, 'ops/n8n/node_modules/n8n/bin/n8n')
  if (cli.path !== expectedCli) fail('n8n CLI is outside the immutable runtime')
  const child = processIdentity(readPid(values['--pid-file']), node, cli)
  if (expectedChild && (child.pid !== expectedChild.pid
    || child.startToken !== expectedChild.startToken)) {
    fail('n8n child changed before complete startup')
  }
  return {
    runtime,
    node,
    cli,
    child,
    n8nVersion: n8nVersion(runtime),
    workflowIds: managedWorkflowIds(runtime),
  }
}
function writeWitness(pathname, value) {
  noSymlink(pathname, 'n8n startup witness', true)
  safeEntry(dirname(pathname), 'n8n startup witness directory', 'directory', 0o700)
  if (existsSync(pathname)) fail('n8n startup witness already exists')
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  if (source.length > MAX_WITNESS_BYTES) fail('n8n startup witness is too large')
  const temporary = join(dirname(pathname), `.n8n-startup-witness.${process.pid}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let offset = 0
    while (offset < source.length) offset += writeSync(descriptor, source, offset, source.length - offset)
    fsyncSync(descriptor)
    chmodSync(temporary, 0o600)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, pathname)
    const parent = openSync(dirname(pathname), constants.O_RDONLY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  } catch (error) {
    try { if (descriptor !== undefined) closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}
function parseWitness(pathname, requireCurrentHelper = true) {
  let value
  try { value = JSON.parse(readStable(pathname, 'n8n startup witness', 0o600).toString('utf8')) }
  catch { fail('n8n startup witness is invalid') }
  exactKeys(value, [
    'schema', 'observedAt', 'sourceCommit', 'n8nVersion', 'completion',
    'child', 'runtime', 'node', 'cli', 'helperSha256',
  ], 'n8n startup witness')
  exactKeys(value.completion, ['label', 'url', 'workflowIds', 'sha256'], 'n8n startup completion')
  exactKeys(value.child, ['pid', 'uid', 'startToken', 'argvSha256'], 'n8n startup child')
  for (const name of ['runtime', 'node', 'cli']) {
    exactKeys(value[name], name === 'runtime' ? ['path', 'dev', 'ino', 'sourceCommit'] : ['path', 'dev', 'ino'],
      `n8n startup ${name}`)
  }
  if (value.schema !== N8N_COMPLETE_STARTUP_WITNESS_SCHEMA
    || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0
    || !COMMIT.test(value.sourceCommit || '') || value.runtime.sourceCommit !== value.sourceCommit
    || value.n8nVersion !== N8N_VERSION || value.completion.label !== COMPLETION_LABEL
    || !Array.isArray(value.completion.workflowIds)
    || value.completion.workflowIds.length !== MANAGED_WORKFLOW_FILES.length
    || new Set(value.completion.workflowIds).size !== MANAGED_WORKFLOW_FILES.length
    || !SHA256.test(value.completion.sha256 || '') || !SHA256.test(value.child.argvSha256 || '')
    || !SHA256.test(value.helperSha256 || '')
    || (requireCurrentHelper && value.helperSha256 !== sha256(readFileSync(scriptPath)))) {
    fail('n8n startup witness contract is invalid')
  }
  return value
}
async function readiness(urlValue) {
  const origin = loopbackOrigin(new URL(urlValue).origin, 'n8n readiness origin')
  const url = new URL(urlValue)
  if (`${url.protocol}//${url.hostname}:${url.port}` !== origin
    || url.pathname !== '/healthz/readiness' || url.search || url.hash) {
    fail('n8n readiness URL is invalid')
  }
  await new Promise((resolvePromise, reject) => {
    const request = get(url, { timeout: 3_000 }, response => {
      response.resume()
      if (response.statusCode === 200) resolvePromise()
      else reject(new Error(`readiness status ${String(response.statusCode)}`))
    })
    request.once('timeout', () => request.destroy(new Error('readiness timeout')))
    request.once('error', reject)
  }).catch(() => fail('n8n official readiness check failed'))
}

export async function verifyN8nCompleteStartupWitness(values) {
  for (const name of ['--witness', '--pid-file', '--runtime-root', '--node-bin', '--cli']) {
    normalizedAbsolute(values[name], name)
  }
  const witness = parseWitness(values['--witness'])
  const current = captureBinding(values)
  const expectedCompletion = `${COMPLETION_LABEL}\n${witness.completion.url}\n${current.workflowIds.join('\n')}`
  if (canonicalJson(witness.child) !== canonicalJson(current.child)
    || canonicalJson(witness.runtime) !== canonicalJson(current.runtime)
    || canonicalJson(witness.node) !== canonicalJson(current.node)
    || canonicalJson(witness.cli) !== canonicalJson(current.cli)
    || witness.sourceCommit !== current.runtime.sourceCommit
    || witness.n8nVersion !== current.n8nVersion
    || canonicalJson(witness.completion.workflowIds) !== canonicalJson(current.workflowIds)
    || witness.completion.sha256 !== sha256(expectedCompletion)) {
    fail('n8n startup witness no longer matches the live child')
  }
  await readiness(values['--readiness-url'])
  return {
    schema: N8N_COMPLETE_STARTUP_WITNESS_SCHEMA,
    pid: current.child.pid,
    sourceCommit: current.runtime.sourceCommit,
    observedAt: witness.observedAt,
  }
}

function parseArguments(argv) {
  const command = argv[0]
  const names = {
    observe: [
      '--pid-file', '--runtime-root', '--node-bin', '--cli', '--witness', '--expected-origin',
      '--expected-pid', '--expected-start',
    ],
    verify: ['--pid-file', '--runtime-root', '--node-bin', '--cli', '--witness', '--readiness-url'],
    clear: ['--witness', '--expected-pid', '--expected-start'],
    'clear-stale': ['--witness'],
  }[command]
  if (!names) fail('expected observe, verify, clear, or clear-stale')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    if (!names.includes(argv[index]) || !argv[index + 1] || Object.hasOwn(values, argv[index])) {
      fail('arguments are invalid')
    }
    values[argv[index]] = argv[index + 1]
  }
  if (Object.keys(values).length !== names.length) fail('arguments are incomplete')
  return { command, values }
}
function stripAnsi(value) { return value.replace(/\u001b\[[0-9;]*m/gu, '') }
async function observe(values) {
  let expectedOrigin
  let expectedChild
  let expectedWorkflowIds = []
  let witnessFailure = null
  try {
    for (const name of ['--pid-file', '--runtime-root', '--node-bin', '--cli', '--witness']) {
      normalizedAbsolute(values[name], name)
    }
    expectedOrigin = loopbackOrigin(values['--expected-origin'], 'expected n8n origin')
    if (!['', 'false'].includes(process.env.N8N_USE_WORKFLOW_PUBLICATION_SERVICE || '')
      || !['', 'text'].includes(process.env.N8N_LOG_FORMAT || '')
      || !['', 'info'].includes(process.env.N8N_LOG_LEVEL || '')) {
      fail('n8n startup witness requires synchronous publication with text info logging')
    }
    const expectedPid = Number(values['--expected-pid'])
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0
      || typeof values['--expected-start'] !== 'string' || !values['--expected-start'].trim()) {
      fail('expected n8n child identity is invalid')
    }
    expectedChild = { pid: expectedPid, startToken: values['--expected-start'] }
    expectedWorkflowIds = managedWorkflowIds(runtimeIdentity(values['--runtime-root']))
  } catch (error) {
    witnessFailure = error
  }
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let markerSeen = false
  let witnessed = false
  const activatedWorkflowIds = new Set()
  let stopRequested = false
  const stopObserving = () => {
    stopRequested = true
    process.stdin.destroy()
  }
  const inspectLine = lineValue => {
    const line = stripAnsi(lineValue.trim())
    const activation = /Activated workflow .+ \(ID: ([A-Za-z0-9_-]{1,120})\)/u.exec(line)
    if (activation && expectedWorkflowIds.includes(activation[1])) {
      activatedWorkflowIds.add(activation[1])
    }
    if (!markerSeen) {
      if (line === COMPLETION_LABEL) markerSeen = true
      return
    }
    if (!line) return
    let observedOrigin
    try { observedOrigin = loopbackOrigin(line, 'n8n completion URL') } catch {
      markerSeen = line === COMPLETION_LABEL
      return
    }
    markerSeen = false
    if (observedOrigin !== expectedOrigin || witnessed) return
    const binding = captureBinding(values, expectedChild)
    if (binding.workflowIds.some(id => !activatedWorkflowIds.has(id))) {
      fail('n8n managed workflows did not all report activation before complete startup')
    }
    const observedAt = Math.floor(Date.now() / 1000)
    writeWitness(values['--witness'], {
      schema: N8N_COMPLETE_STARTUP_WITNESS_SCHEMA,
      observedAt,
      sourceCommit: binding.runtime.sourceCommit,
      n8nVersion: binding.n8nVersion,
      completion: {
        label: COMPLETION_LABEL,
        url: observedOrigin,
        workflowIds: binding.workflowIds,
        sha256: sha256(`${COMPLETION_LABEL}\n${observedOrigin}\n${binding.workflowIds.join('\n')}`),
      },
      child: binding.child,
      runtime: binding.runtime,
      node: binding.node,
      cli: binding.cli,
      helperSha256: sha256(readFileSync(scriptPath)),
    })
    witnessed = true
    activatedWorkflowIds.clear()
  }
  process.once('SIGTERM', stopObserving)
  process.once('SIGINT', stopObserving)
  try {
    for await (const chunk of process.stdin) {
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain')
      if (witnessed || witnessFailure) {
        pending = ''
        continue
      }
      pending += decoder.write(chunk)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).replace(/\r$/u, '')
        if (Buffer.byteLength(line) > MAX_PENDING_STDOUT_BYTES) {
          witnessFailure = new Error('n8n startup witness failed: n8n startup stdout line exceeded the witness buffer')
          pending = ''
          activatedWorkflowIds.clear()
          break
        }
        try { inspectLine(line) } catch (error) { witnessFailure = error }
        pending = pending.slice(newline + 1)
        if (witnessed || witnessFailure) {
          pending = ''
          activatedWorkflowIds.clear()
          break
        }
      }
      if (Buffer.byteLength(pending) > MAX_PENDING_STDOUT_BYTES) {
        witnessFailure = new Error('n8n startup witness failed: n8n startup stdout line exceeded the witness buffer')
        pending = ''
        activatedWorkflowIds.clear()
      }
    }
  } catch (error) {
    if (!stopRequested || error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  } finally {
    process.removeListener('SIGTERM', stopObserving)
    process.removeListener('SIGINT', stopObserving)
  }
  pending += decoder.end()
  if (!witnessFailure && Buffer.byteLength(pending) > MAX_PENDING_STDOUT_BYTES) {
    witnessFailure = new Error('n8n startup witness failed: n8n startup stdout line exceeded the witness buffer')
  }
  if (!witnessFailure && pending) {
    try { inspectLine(pending) } catch (error) { witnessFailure = error }
  }
  if (witnessFailure) throw witnessFailure
  if (!witnessed) fail('n8n complete startup marker was not observed')
}
function clear(values) {
  normalizedAbsolute(values['--witness'], '--witness')
  if (!existsSync(values['--witness'])) return
  const expectedPid = Number(values['--expected-pid'])
  const expectedStart = values['--expected-start']
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0
    || typeof expectedStart !== 'string' || !expectedStart.trim()) {
    fail('expected n8n child identity is invalid')
  }
  const witness = parseWitness(values['--witness'])
  if (witness.child.pid !== expectedPid || witness.child.startToken !== expectedStart) {
    fail('refusing to clear another n8n child witness')
  }
  unlinkSync(values['--witness'])
  const parent = openSync(dirname(values['--witness']), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function clearStale(values) {
  normalizedAbsolute(values['--witness'], '--witness')
  if (!existsSync(values['--witness'])) return
  const witness = parseWitness(values['--witness'], false)
  try {
    process.kill(witness.child.pid, 0)
    const currentStart = run('/bin/ps', [
      '-p', String(witness.child.pid), '-o', 'lstart=',
    ], 'recorded n8n child start query')
    if (currentStart === witness.child.startToken) fail('recorded n8n child is still running')
  } catch (error) {
    if (error instanceof Error && error.message.includes('still running')) throw error
    if (error?.code !== 'ESRCH') fail('recorded n8n child liveness is unknown')
  }
  unlinkSync(values['--witness'])
  const parent = openSync(dirname(values['--witness']), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv)
  if (command === 'observe') return observe(values)
  if (command === 'verify') {
    process.stdout.write(`${JSON.stringify(await verifyN8nCompleteStartupWitness(values))}\n`)
    return
  }
  if (command === 'clear-stale') return clearStale(values)
  clear(values)
}

let invokedPath = null
try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]) } catch {}
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
