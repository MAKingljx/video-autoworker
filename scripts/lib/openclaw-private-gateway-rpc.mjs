import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_OPENCLAW_VERSION = '2026.7.1-2'
const LOOPBACK_URL = 'ws://127.0.0.1:18889'
const TARGET_AGENT_ID = 'second-original'
const MAX_RESULT_BYTES = 8 * 1024 * 1024

function fail() {
  throw new Error('private Gateway RPC failed')
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
      if (manifest?.name === 'openclaw' && manifest?.version === EXPECTED_OPENCLAW_VERSION) {
        return current
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail()
}

async function loadCallGatewayCli() {
  const root = readOpenClawPackageRoot()
  const dist = path.join(root, 'dist')
  const candidates = fs.readdirSync(dist, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^call-[A-Za-z0-9_-]+\.js$/u.test(entry.name))
    .map(entry => path.join(dist, entry.name))
    .filter(candidate => {
      const source = fs.readFileSync(candidate, 'utf8')
      return source.includes('export { GatewayCredentialsRequiredError')
        && source.includes('callGatewayCli')
    })
  if (candidates.length !== 1) fail()
  const loaded = await import(pathToFileURL(candidates[0]).href)
  if (typeof loaded.callGatewayCli !== 'function') fail()
  return loaded.callGatewayCli
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
    const baseHash = secret('AIWORKER_OPENCLAW_RUNTIME_BASE_HASH')
    if (!/^[a-f0-9]{64}$/u.test(baseHash)) fail()
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

async function main() {
  const [operation, outputPath, ...extra] = process.argv.slice(2)
  if (!operation || !outputPath || extra.length !== 0) fail()
  const gatewayToken = secret('OPENCLAW_GATEWAY_TOKEN')
  const sessionKey = process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY || ''
  const callGatewayCli = await loadCallGatewayCli()
  const request = operationRequest(operation)
  const result = await callGatewayCli({
    ...request,
    url: LOOPBACK_URL,
    token: gatewayToken,
    timeoutMs: 20_000,
  })
  const source = `${JSON.stringify(result)}\n`
  if ([gatewayToken, sessionKey].filter(Boolean).some(value => source.includes(value))) fail()
  safeOutput(outputPath, source)
}

main().catch(() => {
  process.stderr.write('Private loopback Gateway RPC failed without exposing credentials.\n')
  process.exitCode = 1
})
