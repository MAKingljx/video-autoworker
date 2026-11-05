import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  OPENCLAW_GATEWAY_RUNTIME_EXPORT,
  OPENCLAW_PACKAGE_NAME,
  OPENCLAW_RUNTIME_VERSION,
  isOpenClawConfigRevisionToken,
} from './openclaw-runtime-contract.mjs'

const LOOPBACK_URL = 'ws://127.0.0.1:18889'
const TARGET_AGENT_ID = 'second-original'
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const SUPPORTED_OPERATIONS = new Set([
  'catalog', 'effective', 'health', 'logs-tail', 'config-get', 'config-patch',
])
const ERROR_CATEGORIES = new Set([
  'contract_invalid', 'result_contains_secret', 'result_projection_invalid', 'rpc_call_failed',
])
const MAX_LOG_LINES = 5_000
const MAX_LOG_LINE_BYTES = 64 * 1024
const SAFE_CONFIG_CHANGE = /^config change detected; evaluating reload \(([A-Za-z0-9_.-]+(?:,\s*[A-Za-z0-9_.-]+)*)\)$/u
const SAFE_FAILURE_MESSAGES = [
  [/^config hot-reload failed\b/iu, 'config hot-reload failed'],
  [/^config reload (?:in-process )?last-known-good promotion failed\b/iu, 'config reload last-known-good promotion failed'],
  [/^config reload disabled \(gateway\.reload\.mode=off\)$/iu, 'config reload disabled (gateway.reload.mode=off)'],
  [/^config change requires gateway restart\b/iu, 'config change requires gateway restart'],
  [/^config reload requires gateway restart\b/iu, 'config reload requires gateway restart'],
  [/^config restart failed\b/iu, 'config restart failed'],
  [/\brestart pending\b/iu, 'restart pending'],
]

function fail(category = 'contract_invalid') {
  const error = new Error('private Gateway RPC failed')
  error.category = category
  throw error
}

function secret(name, required = true) {
  const value = process.env[name] || ''
  if ((required && value.length === 0) || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}

function normalizedAbsolute(value) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}

function readOpenClawPackageRoot() {
  const entry = fs.realpathSync(normalizedAbsolute(process.env.OPENCLAW_BIN || ''))
  let current = path.dirname(entry)
  for (let depth = 0; depth < 4; depth += 1) {
    const packagePath = path.join(current, 'package.json')
    if (fs.existsSync(packagePath)) {
      const packageEntry = fs.lstatSync(packagePath)
      if (!packageEntry.isFile() || packageEntry.isSymbolicLink()) fail()
      const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
      if (manifest?.name === OPENCLAW_PACKAGE_NAME && manifest?.version === OPENCLAW_RUNTIME_VERSION) {
        return current
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail()
}

async function loadCallGatewayFromCli() {
  const root = readOpenClawPackageRoot()
  const scopedRequire = createRequire(path.join(root, 'package.json'))
  let exportedPath
  try { exportedPath = scopedRequire.resolve(OPENCLAW_GATEWAY_RUNTIME_EXPORT) } catch { fail() }
  const loaded = await import(pathToFileURL(exportedPath).href)
  if (typeof loaded.callGatewayFromCli !== 'function') fail()
  return loaded.callGatewayFromCli
}

function safeOutput(pathname, source) {
  pathname = normalizedAbsolute(pathname)
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600 || entry.size !== 0
    || fs.realpathSync(pathname) !== pathname || Buffer.byteLength(source) > MAX_RESULT_BYTES) fail()
  const descriptor = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
  try {
    fs.writeFileSync(descriptor, source)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function operationRequest(operation) {
  if (operation === 'catalog') {
    return { method: 'tools.catalog', params: { agentId: TARGET_AGENT_ID, includePlugins: true } }
  }
  if (operation === 'effective') {
    return {
      method: 'tools.effective',
      params: { agentId: TARGET_AGENT_ID, sessionKey: secret('AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY') },
    }
  }
  if (operation === 'health') return { method: 'health', params: { probe: true } }
  if (operation === 'logs-tail') {
    const cursorSource = process.env.AIWORKER_OPENCLAW_RUNTIME_LOG_CURSOR || ''
    const cursor = cursorSource === '' ? undefined : Number(cursorSource)
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) fail()
    return {
      method: 'logs.tail',
      params: { ...(cursor === undefined ? {} : { cursor }), limit: 5000, maxBytes: 1_000_000 },
    }
  }
  if (operation === 'config-get') return { method: 'config.get', params: {} }
  if (operation === 'config-patch') {
    const baseHash = secret('AIWORKER_OPENCLAW_RUNTIME_REVISION_TOKEN', false)
      || secret('AIWORKER_OPENCLAW_RUNTIME_BASE_HASH')
    if (!isOpenClawConfigRevisionToken(baseHash)) fail()
    const patchPath = normalizedAbsolute(process.env.AIWORKER_OPENCLAW_RUNTIME_PATCH_FILE || '')
    const patchEntry = fs.lstatSync(patchPath)
    if (!patchEntry.isFile() || patchEntry.isSymbolicLink() || patchEntry.uid !== process.getuid()
      || patchEntry.nlink !== 1 || (patchEntry.mode & 0o077) !== 0
      || patchEntry.size <= 0 || patchEntry.size > 1024 * 1024) fail()
    const raw = fs.readFileSync(patchPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail()
    return { method: 'config.patch', params: { raw, baseHash } }
  }
  fail()
}

function logMessageCandidates(line) {
  try {
    const value = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return [value.message, value.msg, ...Object.keys(value)
      .filter(key => /^\d+$/u.test(key))
      .toSorted((left, right) => Number(left) - Number(right))
      .map(key => value[key])]
      .filter(value => typeof value === 'string')
  } catch { return [line] }
}

function projectSafeLogMessage(line) {
  for (const candidate of logMessageCandidates(line)) {
    if (Buffer.byteLength(candidate) > MAX_LOG_LINE_BYTES) continue
    const message = candidate.trim()
    if (SAFE_CONFIG_CHANGE.test(message)) return message
    for (const [pattern, canonical] of SAFE_FAILURE_MESSAGES) {
      if (pattern.test(message)) return canonical
    }
  }
  return null
}

function projectGatewayLogTail(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.file !== 'string' || !path.isAbsolute(result.file)
    || path.resolve(result.file) !== result.file || /[\u0000-\u001f\u007f]/u.test(result.file)
    || !Number.isSafeInteger(result.cursor) || result.cursor < 0
    || !Number.isSafeInteger(result.size) || result.size < 0 || result.cursor !== result.size
    || !Array.isArray(result.lines) || result.lines.length > MAX_LOG_LINES
    || result.lines.some(line => typeof line !== 'string' || Buffer.byteLength(line) > MAX_LOG_LINE_BYTES)
    || typeof result.reset !== 'boolean' || typeof result.truncated !== 'boolean') {
    fail('result_projection_invalid')
  }
  const lines = []
  let omitted = false
  for (const line of result.lines) {
    const message = projectSafeLogMessage(line)
    if (message === null) { omitted = true; continue }
    lines.push(JSON.stringify({ message }))
  }
  if (omitted) lines.push(JSON.stringify({ message: '[redacted gateway log entries omitted]' }))
  return { file: result.file, cursor: result.cursor, size: result.size, lines,
    truncated: result.truncated, reset: result.reset }
}

export function projectPrivateGatewayResult(operation, result) {
  if (!SUPPORTED_OPERATIONS.has(operation)) fail('contract_invalid')
  if (operation === 'logs-tail') return projectGatewayLogTail(result)
  if (operation !== 'health') return result
  const hotReloadStatus = result?.configReload?.hotReloadStatus
  if (typeof result?.ok !== 'boolean' || typeof hotReloadStatus !== 'string'
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(hotReloadStatus)) {
    fail('result_projection_invalid')
  }
  return { ok: result.ok, configReload: { hotReloadStatus } }
}

export function serializePrivateGatewayResult(
  operation,
  result,
  gatewayToken = '',
  sessionKey = '',
) {
  const source = `${JSON.stringify(projectPrivateGatewayResult(operation, result))}\n`
  if ([gatewayToken, sessionKey].filter(Boolean).some(value => source.includes(value))) {
    fail('result_contains_secret')
  }
  return source
}

async function main() {
  const [operation, outputPath, ...extra] = process.argv.slice(2)
  if (!operation || !outputPath || extra.length !== 0) fail()
  const gatewayToken = secret('OPENCLAW_GATEWAY_TOKEN')
  const sessionKey = process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY || ''
  const callGatewayFromCli = await loadCallGatewayFromCli()
  const request = operationRequest(operation)
  let result
  try {
    result = await callGatewayFromCli(request.method, {
      url: LOOPBACK_URL,
      token: gatewayToken,
      timeout: 20_000,
    }, request.params, { expectFinal: true, sharedStateMode: 'read-only' })
  } catch { fail('rpc_call_failed') }
  const source = serializePrivateGatewayResult(operation, result, gatewayToken, sessionKey)
  safeOutput(outputPath, source)
}

let isMain = false
try {
  isMain = process.argv[1] !== undefined
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch { /* imported modules and unavailable entry paths do not dispatch the CLI */ }
if (isMain) {
  const operation = SUPPORTED_OPERATIONS.has(process.argv[2]) ? process.argv[2] : 'invalid'
  main().catch(error => {
    const category = ERROR_CATEGORIES.has(error?.category) ? error.category : 'contract_invalid'
    process.stderr.write(
      `Private loopback Gateway RPC failed without exposing credentials (operation=${operation}, category=${category}).\n`,
    )
    process.exitCode = 1
  })
}
