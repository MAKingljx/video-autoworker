import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const MAX_OUTPUT_BYTES = 4_096
const DEFAULT_TIMEOUT_MS = 10_000

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

export function isValidExecSecretReference(reference, providers) {
  if (!hasExactKeys(reference, ['id', 'provider', 'source']) || reference.source !== 'exec') return false
  if (typeof reference.id !== 'string' || !reference.id) return false
  if (typeof reference.provider !== 'string' || !reference.provider) return false
  const provider = providers?.[reference.provider]
  return Boolean(provider
    && hasExactKeys(provider, ['args', 'command', 'source'])
    && provider.source === 'exec'
    && typeof provider.command === 'string'
    && provider.command.startsWith('/')
    && Array.isArray(provider.args)
    && provider.args.every(value => typeof value === 'string' && !/[\r\n\0]/u.test(value)))
}

export function resolveExecSecretReference(reference, providers, {
  valuePattern = TOKEN_PATTERN,
  maxBuffer = MAX_OUTPUT_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!isValidExecSecretReference(reference, providers)) return ''
  const provider = providers[reference.provider]
  let result
  try {
    result = spawnSync(provider.command, provider.args, {
      encoding: 'utf8',
      env: {},
      maxBuffer,
      timeout: timeoutMs,
      windowsHide: true,
    })
  } catch {
    return ''
  }
  if (result.error || result.signal || result.status !== 0) return ''
  const value = String(result.stdout || '').trim()
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
