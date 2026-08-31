import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getMaterialsOverview } from '@/lib/openclaw-materials'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'

export async function GET(request: NextRequest) {
  const auth = authorizeMaterialsRequest(request, 'viewer')
  if ('response' in auth) return auth.response

  try {
    const overview = await getMaterialsOverview()
    return NextResponse.json(overview, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const failure = projectSafeOperationError(error, 'MATERIALS_OVERVIEW_FAILED')
    logSafeOperationError('materials_overview', error, failure)
    return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 502 })
  }
}

export function authorizeMaterialsRequest(
  request: NextRequest,
  minRole: 'viewer' | 'operator' | 'admin',
): { actor: string } | { response: NextResponse } {
  if (isLocalDesktopRequest(request)) return { actor: 'local-desktop' }

  const auth = requireRole(request, minRole)
  if ('error' in auth) {
    return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  }

  return { actor: auth.user.username || 'system' }
}

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
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

function isLocalDesktopRequest(request: NextRequest): boolean {
  const enabled = envFlag('MC_OPENCLAW_PROFILES_NO_AUTH') || envFlag('MC_DESKTOP_MODE')
  if (!enabled) return false

  const rawCandidates = [
    request.headers.get('x-forwarded-host') || '',
    request.headers.get('host') || '',
    request.nextUrl.host || '',
    request.nextUrl.hostname || '',
  ].flatMap((host) => host.split(','))

  return rawCandidates.some(isLoopbackHost)
}
