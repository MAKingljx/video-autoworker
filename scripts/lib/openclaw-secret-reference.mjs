import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPENCLAW_SECRETREF_WRAPPER } from './openclaw-runtime-contract.mjs'

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const MAX_OUTPUT_BYTES = 4_096
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const MAX_PROVIDER_OUTPUT_BYTES = 20 * 1024 * 1024
const OPTIONAL_PROVIDER_KEYS = [
  'timeoutMs', 'noOutputTimeoutMs', 'maxOutputBytes', 'jsonOnly',
  'trustedDirs', 'passEnv',
]

function isSafeAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && isAbsolute(value) && normalize(value) === value
}

function isWithinDirectory(directory, pathname) {
  const suffix = relative(directory, pathname)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function isTimeout(value) {
  return Number.isSafeInteger(value) && value >= 1_000 && value <= MAX_TIMEOUT_MS
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function hasOnlyKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every(key => keys.includes(key)) && keys.every(key => allowed.has(key))
}

export function isValidExecSecretReference(reference, providers) {
  if (!hasExactKeys(reference, ['id', 'provider', 'source']) || reference.source !== 'exec') return false
  if (typeof reference.id !== 'string' || !reference.id) return false
  if (typeof reference.provider !== 'string' || !reference.provider) return false
  const provider = providers?.[reference.provider]
  const home = process.env.HOME || ''
  const trustedDirectory = join(home, 'ai-worker/bin')
  const expectedCommand = join(home, OPENCLAW_SECRETREF_WRAPPER.relativePath)
  const expectedKeychain = join(home, 'Library/Keychains/login.keychain-db')
  const common = Boolean(provider
    && hasOnlyKeys(provider, ['args', 'command', 'source'], OPTIONAL_PROVIDER_KEYS)
    && provider.source === 'exec'
    && isSafeAbsolutePath(provider.command)
    && Array.isArray(provider.args) && provider.args.length <= 128
    && provider.args.every(value => typeof value === 'string' && value.length <= 1_024
      && !/[\u0000-\u001f\u007f]/u.test(value))
    && (provider.timeoutMs === undefined || isTimeout(provider.timeoutMs))
    && (provider.noOutputTimeoutMs === undefined || isTimeout(provider.noOutputTimeoutMs))
    && (provider.maxOutputBytes === undefined || (Number.isSafeInteger(provider.maxOutputBytes)
      && provider.maxOutputBytes > 0 && provider.maxOutputBytes <= MAX_PROVIDER_OUTPUT_BYTES))
    // This shared adapter resolves one raw value, as required by security -w.
    // JSON/stdin and inherited-environment providers remain unsupported.
    && (provider.jsonOnly === undefined || provider.jsonOnly === false)
    && (provider.trustedDirs === undefined || (Array.isArray(provider.trustedDirs)
      && provider.trustedDirs.length > 0 && provider.trustedDirs.length <= 64
      && provider.trustedDirs.every(isSafeAbsolutePath)
      && provider.trustedDirs.some(directory => isWithinDirectory(directory, provider.command)))))
  if (!common) return false
  if (provider.passEnv === undefined) return true
  return Boolean(home && provider.command === expectedCommand
    && provider.args.length === 3
    && provider.args[0] && !provider.args[0].startsWith('-')
    && provider.args[1] && !provider.args[1].startsWith('-')
    && provider.args[2] === expectedKeychain
    && provider.jsonOnly === false
    && Array.isArray(provider.trustedDirs)
    && provider.trustedDirs.length === 1 && provider.trustedDirs[0] === trustedDirectory
    && Array.isArray(provider.passEnv)
    && provider.passEnv.length === 1 && provider.passEnv[0] === 'HOME')
}

function isApprovedHomeWrapper(provider) {
  const home = process.env.HOME || ''
  return home && provider.command === join(home, OPENCLAW_SECRETREF_WRAPPER.relativePath)
    && Array.isArray(provider.passEnv) && provider.passEnv.length === 1
    && provider.passEnv[0] === 'HOME'
}

function resolveProviderCommand(provider) {
  const entry = lstatSync(provider.command)
  if (!entry.isFile() || entry.isSymbolicLink()) return ''
  const command = realpathSync(provider.command)
  const resolved = lstatSync(command)
  if (entry.dev !== resolved.dev || entry.ino !== resolved.ino) return ''
  // A configured permission exception never bypasses the trusted-directory
  // boundary. Check physical paths as well as the lexical schema check above.
  if (provider.trustedDirs && !provider.trustedDirs.some(directory => {
    const physical = realpathSync(directory)
    return lstatSync(physical).isDirectory() && isWithinDirectory(physical, command)
  })) return ''
  if (isApprovedHomeWrapper(provider)) {
    if ((entry.mode & 0o777) !== OPENCLAW_SECRETREF_WRAPPER.mode
      || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
      || createHash('sha256').update(readFileSync(command)).digest('hex')
        !== OPENCLAW_SECRETREF_WRAPPER.sha256) return ''
  } else if ((entry.mode & 0o022) !== 0
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) return ''
  return command
}

export function resolveExecSecretReference(reference, providers, {
  valuePattern = TOKEN_PATTERN,
  maxBuffer = MAX_OUTPUT_BYTES,
  timeoutMs,
} = {}) {
  if (!isValidExecSecretReference(reference, providers)) return ''
  const provider = providers[reference.provider]
  if ((timeoutMs !== undefined && !isTimeout(timeoutMs))
    || !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) return ''
  const providerTimeout = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // spawnSync cannot measure gaps between output chunks. Treat the configured
  // no-output budget as a stricter total deadline, never silently ignore it.
  const effectiveTimeoutMs = Math.min(
    timeoutMs ?? providerTimeout,
    providerTimeout,
    provider.noOutputTimeoutMs ?? providerTimeout,
  )
  const effectiveMaxBuffer = Math.min(maxBuffer, MAX_OUTPUT_BYTES, provider.maxOutputBytes ?? MAX_OUTPUT_BYTES)
  let result
  try {
    const command = resolveProviderCommand(provider)
    if (!command) return ''
    result = spawnSync(command, provider.args, {
      encoding: 'utf8',
      cwd: dirname(command),
      env: isApprovedHomeWrapper(provider) ? { HOME: process.env.HOME } : {},
      shell: false,
      maxBuffer: effectiveMaxBuffer,
      timeout: effectiveTimeoutMs,
      windowsHide: true,
    })
  } catch {
    return ''
  }
  if (result.error || result.signal || result.status !== 0) return ''
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > effectiveMaxBuffer) return ''
  const value = stdout.trim()
  return valuePattern.test(value) ? value : ''
}

export function resolveOpenClawGatewaySecret(reference, providers) {
  return resolveExecSecretReference(reference, providers, { valuePattern: TOKEN_PATTERN })
}

export function resolveGatewayTokenFromConfig(config) {
  return resolveOpenClawGatewaySecret(config?.gateway?.auth?.token, config?.secrets?.providers)
}

export function resolveGatewayTokenFromConfigPath(configPath) {
  try {
    return resolveGatewayTokenFromConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return ''
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = typeof process.argv[2] === 'string'
    ? resolveGatewayTokenFromConfigPath(process.argv[2])
    : ''
  if (!token) process.exitCode = 1
  else process.stdout.write(`${token}\n`)
}
