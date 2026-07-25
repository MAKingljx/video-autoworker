import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { generateProfilesAcceptanceReport } from '@/lib/openclaw-profiles'

export async function GET(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'viewer')
  if ('response' in auth) return auth.response

  try {
    const report = await generateProfilesAcceptanceReport()
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '生成验收报告失败' },
      { status: 502 },
    )
  }
}

function authorizeProfilesRequest(
  request: NextRequest,
  minRole: 'viewer' | 'operator' | 'admin',
): { actor: string } | { response: NextResponse } {
  if (isLocalProfilesDesktopRequest(request)) {
    return { actor: 'local-desktop' }
  }

  const auth = requireRole(request, minRole)
  if ('error' in auth) {
    return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  }

  return { actor: auth.user.username || 'system' }
}

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
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

  const rawCandidates = [
    request.headers.get('x-forwarded-host') || '',
    request.headers.get('host') || '',
    request.nextUrl.host || '',
    request.nextUrl.hostname || '',
  ].flatMap(host => host.split(','))

  return rawCandidates.some(isLoopbackHost)
}
