#!/usr/bin/env node

import { createServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ROUTER_STATE_SCHEMA = 'video-autoworker-standalone-router/v1'
export const ROUTER_HEALTH_SCHEMA = 'video-autoworker-standalone-router-health/v1'
export const ROUTER_RUNTIME_SCHEMA = 'video-autoworker-standalone-router-runtime/v1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function safeRouterDiagnostic(error) {
  return String(error instanceof Error ? error.message : error || 'unknown')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?<![A-Za-z0-9])\/(?:[^\s,;]+\/)*[^\s,;]*/g, '[path]')
    .replace(/[A-Za-z]:\\[^\s,;]+/g, '[path]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[secret]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000)
}

function logRouterError(context, error) {
  process.stderr.write(`${JSON.stringify({
    event: 'standalone_router_error',
    context,
    code: 'N8N_ROUTER_STATE_UNAVAILABLE',
    diagnostic: safeRouterDiagnostic(error),
  })}\n`)
}

function fail(message) {
  throw new Error(`standalone_router_${message}`)
}

function integer(value, label, minimum = 1, maximum = 65_535) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) fail(`${label}_invalid`)
  return parsed
}

function safeReleaseId(value, label) {
  const releaseId = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)) fail(`${label}_invalid`)
  return releaseId
}

export function validateRouterState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('state_invalid')
  if (value.schema !== ROUTER_STATE_SCHEMA) fail('state_schema')
  if (value.active !== 'blue' && value.active !== 'green') fail('active_slot')
  if (value.previous !== null && value.previous !== 'blue' && value.previous !== 'green') {
    fail('previous_slot')
  }
  if (value.previous === value.active) fail('previous_equals_active')
  const generation = integer(value.generation, 'generation', 1, Number.MAX_SAFE_INTEGER)
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)) fail('slots_invalid')

  const slots = {}
  for (const name of ['blue', 'green']) {
    const candidate = value.slots[name]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail(`${name}_slot_invalid`)
    const host = String(candidate.host || '').trim()
    if (!LOOPBACK_HOSTS.has(host)) fail(`${name}_host_not_loopback`)
    slots[name] = {
      host,
      port: integer(candidate.port, `${name}_port`),
      releaseId: safeReleaseId(candidate.releaseId, `${name}_release_id`),
    }
  }
  if (slots.blue.port === slots.green.port) fail('slot_ports_conflict')

  return {
    schema: ROUTER_STATE_SCHEMA,
    generation,
    active: value.active,
    previous: value.previous,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    slots,
  }
}

function assertSafeStateFile(pathname) {
  const stat = lstatSync(pathname)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('state_unsafe_type')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('state_wrong_owner')
  if ((stat.mode & 0o022) !== 0) fail('state_writable_by_others')
}

export function readRouterState(pathname) {
  assertSafeStateFile(pathname)
  return validateRouterState(JSON.parse(readFileSync(pathname, 'utf8')))
}

export function writeRouterStateAtomic(pathname, value) {
  const target = resolve(pathname)
  const state = validateRouterState(value)
  const temporary = `${target}.tmp.${process.pid}.${Date.now()}`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
    let directoryDescriptor
    try {
      directoryDescriptor = openSync(dirname(target), 'r')
      fsyncSync(directoryDescriptor)
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
  return state
}

export function writeRouterRuntimeAttestationAtomic(pathname, value) {
  const target = resolve(pathname)
  if (!value || value.schema !== ROUTER_RUNTIME_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !LOOPBACK_HOSTS.has(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535
    || typeof value.stateFile !== 'string' || !value.stateFile.startsWith('/')
    || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) fail('runtime_attestation_invalid')
  const temporary = `${target}.tmp.${process.pid}.${Date.now()}`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
    let directoryDescriptor
    try {
      directoryDescriptor = openSync(dirname(target), 'r')
      fsyncSync(directoryDescriptor)
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}

function proxyHeaders(headers, backend, preserveUpgrade = false, addBackendHost = true) {
  const output = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (!preserveUpgrade && HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'host' || lower === 'x-forwarded-host' || lower === 'x-forwarded-port') continue
    output[name] = value
  }
  if (addBackendHost) output.host = `${backend.host}:${backend.port}`
  return output
}

function jsonResponse(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

export function createStandaloneRouter(options) {
  const stateFile = resolve(options.stateFile)
  const counters = {
    blue: { requests: 0, activeRequests: 0, upgradedSockets: 0 },
    green: { requests: 0, activeRequests: 0, upgradedSockets: 0 },
  }

  const server = createServer((incoming, outgoing) => {
    let state
    try {
      state = readRouterState(stateFile)
    } catch (error) {
      logRouterError('read_router_state', error)
      jsonResponse(outgoing, 503, {
        ok: false,
        code: 'N8N_ROUTER_STATE_UNAVAILABLE',
        error: '路由状态暂时不可用',
      })
      return
    }

    if (incoming.method === 'GET' && incoming.url === '/__router/health') {
      jsonResponse(outgoing, 200, {
        schema: ROUTER_HEALTH_SCHEMA,
        ok: true,
        pid: process.pid,
        generation: state.generation,
        active: state.active,
        previous: state.previous,
        releaseId: state.slots[state.active].releaseId,
        counters,
      })
      return
    }

    const slot = state.active
    const backend = state.slots[slot]
    counters[slot].requests += 1
    counters[slot].activeRequests += 1
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      counters[slot].activeRequests = Math.max(0, counters[slot].activeRequests - 1)
    }
    outgoing.once('close', settle)
    outgoing.once('finish', settle)

    const proxied = httpRequest({
      hostname: backend.host,
      port: backend.port,
      method: incoming.method,
      path: incoming.url,
      headers: proxyHeaders(incoming.headers, backend),
    }, backendResponse => {
      const headers = proxyHeaders(backendResponse.headers, backend, false, false)
      outgoing.writeHead(backendResponse.statusCode || 502, backendResponse.statusMessage, headers)
      backendResponse.pipe(outgoing)
    })
    proxied.on('error', error => {
      if (!outgoing.headersSent) {
        jsonResponse(outgoing, 502, { ok: false, error: 'standalone_backend_unavailable', detail: error.code || null })
      } else {
        outgoing.destroy(error)
      }
    })
    incoming.on('aborted', () => proxied.destroy())
    incoming.pipe(proxied)
  })

  server.on('upgrade', (incoming, socket, head) => {
    let state
    try {
      state = readRouterState(stateFile)
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    const slot = state.active
    const backend = state.slots[slot]
    const upstream = createConnection({ host: backend.host, port: backend.port })
    let connected = false
    upstream.once('connect', () => {
      connected = true
      counters[slot].upgradedSockets += 1
      const headers = proxyHeaders(incoming.headers, backend, true)
      const lines = [`${incoming.method || 'GET'} ${incoming.url || '/'} HTTP/${incoming.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`)
        } else if (value !== undefined) {
          lines.push(`${name}: ${value}`)
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    const settle = () => {
      if (!connected) return
      connected = false
      counters[slot].upgradedSockets = Math.max(0, counters[slot].upgradedSockets - 1)
    }
    socket.once('close', settle)
    upstream.once('close', settle)
    upstream.once('error', () => {
      if (!connected) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
    socket.once('error', () => upstream.destroy())
  })

  return server
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) fail('argument')
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`argument_${item.slice(2)}`)
    values[item.slice(2)] = value
    index += 1
  }
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv)
  const stateFile = resolve(args['state-file'] || process.env.AIWORKER_BG_ROUTER_STATE || '')
  if (!args['state-file'] && !process.env.AIWORKER_BG_ROUTER_STATE) fail('state_file_required')
  const host = String(args.host || process.env.AIWORKER_BG_ROUTER_HOST || '127.0.0.1')
  if (!LOOPBACK_HOSTS.has(host)) fail('listen_host_not_loopback')
  const port = integer(args.port || process.env.AIWORKER_BG_ROUTER_PORT || 3017, 'listen_port')
  const attestationFile = resolve(args['attestation-file'] || process.env.AIWORKER_BG_ROUTER_ATTESTATION
    || resolve(dirname(stateFile), 'router.runtime.json'))
  if (attestationFile === stateFile) fail('runtime_attestation_conflicts_with_state')
  const initialState = readRouterState(stateFile)
  if (Object.values(initialState.slots).some(slot => slot.host === host && slot.port === port)) {
    fail('listen_port_conflicts_with_backend')
  }

  const server = createStandaloneRouter({ stateFile })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolvePromise)
  })
  writeRouterRuntimeAttestationAtomic(attestationFile, {
    schema: ROUTER_RUNTIME_SCHEMA,
    pid: process.pid,
    host,
    port,
    stateFile,
    startedAt: Math.floor(Date.now() / 1000),
  })
  process.stdout.write(`standalone router listening on http://${host}:${port} state=${dirname(stateFile)}\n`)

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${safeRouterDiagnostic(error)}\n`)
    process.exit(1)
  })
}
