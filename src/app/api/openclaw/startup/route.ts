import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { startOpenClawRuntime } from '@/lib/openclaw-startup'

let startInFlight = false

export async function POST(request: NextRequest) {
  const auth = authorizeStartupRequest(request)
  if ('response' in auth) return auth.response

  if (startInFlight) {
    return NextResponse.json({ error: '一键启动正在执行，请稍后再试' }, { status: 409 })
  }

  startInFlight = true
  try {
    const result = await startOpenClawRuntime(resolvePlatformPort(request))
    auditStartup(auth.actor, result.ok)
    return NextResponse.json({ result }, { status: result.ok ? 200 : 502 })
  } finally {
    startInFlight = false
  }
}

function authorizeStartupRequest(request: NextRequest): { actor: string } | { response: NextResponse } {
  if (isLocalProfilesDesktopRequest(request)) {
    return { actor: 'local-desktop' }
  }

  const auth = requireRole(request, 'admin')
  if ('error' in auth) {
    return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  }

  return { actor: auth.user.username || 'system' }
}

function resolvePlatformPort(request: NextRequest): number {
  const candidate = Number(request.nextUrl.port || process.env.PORT || '3017')
  return Number.isInteger(candidate) && candidate > 0 && candidate <= 65535 ? candidate : 3017
}

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const value = String(raw).trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function hostWithoutPort(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value) return ''
  if (value === '::1') return value
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 1 ? value.slice(1, end).replace(/\.$/, '') : value.replace(/\.$/, '')
  }
  return value.split(':')[0].replace(/\.$/, '')
}

function isLoopbackHost(raw: string): boolean {
  const host = hostWithoutPort(raw)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isLocalProfilesDesktopRequest(request: NextRequest): boolean {
  const enabled = envFlag('MC_OPENCLAW_PROFILES_NO_AUTH') || envFlag('MC_DESKTOP_MODE')
  if (!enabled) return false

  const candidates = [
    request.headers.get('x-forwarded-host') || '',
    request.headers.get('host') || '',
    request.nextUrl.host || '',
    request.nextUrl.hostname || '',
  ].flatMap(host => host.split(','))

  return candidates.some(isLoopbackHost)
}

function auditStartup(actor: string, ok: boolean) {
  try {
    getDatabase().prepare('INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)').run(
      'openclaw.runtime.startup',
      actor,
      JSON.stringify({ ok }),
    )
  } catch {
    // Audit persistence is non-critical for the local control console.
  }
}
