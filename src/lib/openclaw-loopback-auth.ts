export const OPENCLAW_LOOPBACK_AUTH_MODE = 'openclaw-loopback'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const N8N_CALLBACK_PATHS = new Set([
  '/api/n8n/claim',
  '/api/n8n/execute',
  '/api/n8n/media-execute',
  '/api/n8n/node-execute',
])

const N8N_OPENCLAW_OPERATOR_PATHS = new Set([
  ...N8N_CALLBACK_PATHS,
  '/api/n8n/trigger',
  '/api/n8n/director-extraction',
])

const N8N_GLOBAL_RELEASE_PATHS = new Set([
  '/api/n8n/drain-status',
  '/api/n8n/intake-control',
  '/api/n8n/release-readiness',
])

function hostnameWithoutPort(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value) return ''
  if (value === '::1') return value
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 1 ? value.slice(1, end).replace(/\.$/, '') : ''
  }
  return value.split(':')[0].replace(/\.$/, '')
}

function positiveEnvironmentInteger(name: string): number {
  const value = Number(process.env[name] || '1')
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

export function isOpenClawLoopbackAuthMode(): boolean {
  return String(process.env.MC_AUTH_MODE || '').trim().toLowerCase()
    === OPENCLAW_LOOPBACK_AUTH_MODE
}

export function getOpenClawLoopbackScope(): { workspaceId: number; tenantId: number } {
  return {
    workspaceId: positiveEnvironmentInteger('MC_OPENCLAW_WORKSPACE_ID'),
    tenantId: positiveEnvironmentInteger('MC_OPENCLAW_TENANT_ID'),
  }
}

export function isLoopbackHttpRequest(request: Request): boolean {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false

  // When present, Host must describe the same loopback-only trust boundary.
  const host = request.headers.get('host')
  if (host && !LOOPBACK_HOSTS.has(hostnameWithoutPort(host))) return false

  const forwardedHostHeaders = ['x-forwarded-host', 'x-original-host', 'x-forwarded-server']
  for (const name of forwardedHostHeaders) {
    const value = request.headers.get(name)
    if (value && value.split(',').some(candidate => !LOOPBACK_HOSTS.has(hostnameWithoutPort(candidate)))) {
      return false
    }
  }
  const forwardedProto = request.headers.get('x-forwarded-proto')
  if (forwardedProto && forwardedProto.split(',').some(value => value.trim().toLowerCase() !== 'http')) {
    return false
  }
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor && forwardedFor.split(',').some(value => !LOOPBACK_HOSTS.has(hostnameWithoutPort(value)))) {
    return false
  }
  if (request.headers.has('forwarded')) return false
  return true
}

export function requestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname
  } catch {
    return ''
  }
}

export function isOpenClawN8nOperatorRequest(request: Request): boolean {
  return isOpenClawLoopbackAuthMode()
    && isLoopbackHttpRequest(request)
    && request.method.toUpperCase() === 'POST'
    && N8N_OPENCLAW_OPERATOR_PATHS.has(requestPathname(request))
}

export function isOpenClawN8nGlobalReleaseRequest(request: Request): boolean {
  return isOpenClawLoopbackAuthMode()
    && isLoopbackHttpRequest(request)
    && N8N_GLOBAL_RELEASE_PATHS.has(requestPathname(request))
}

export function checkOpenClawN8nCallbackRequest(
  request: Request,
  expectedPath: string,
): { allowed: true } | { allowed: false; error: string; status: 403 } {
  if (!isOpenClawLoopbackAuthMode()) return { allowed: true }
  if (request.method.toUpperCase() !== 'POST'
    || !N8N_CALLBACK_PATHS.has(expectedPath)
    || requestPathname(request) !== expectedPath
    || !isLoopbackHttpRequest(request)) {
    return { allowed: false, error: 'OpenClaw loopback callback required', status: 403 }
  }
  return { allowed: true }
}
