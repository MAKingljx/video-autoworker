import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import {
  assertProfileAction,
  assertProfileId,
  getOpenClawProfile,
  getOpenClawProfiles,
  getProfileStatus,
  runProfileAction,
  type OpenClawProfileAction,
} from '@/lib/openclaw-profiles'

const inFlightActions = new Set<string>()

export async function GET(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'viewer')
  if ('response' in auth) return auth.response

  const profiles = getOpenClawProfiles()
  const statuses = await Promise.all(profiles.map(profile => getProfileStatus(profile)))

  return NextResponse.json({
    profiles: statuses.map(({ raw: _raw, ...status }) => status),
    checkedAt: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'admin')
  if ('response' in auth) return auth.response

  let body: { profile?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '请求内容无效' }, { status: 400 })
  }

  const profileId = String(body?.profile || '')
  const action = String(body?.action || '')

  try {
    assertProfileId(profileId)
    assertProfileAction(action)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  const profile = getOpenClawProfile(profileId)
  if (!profile) return NextResponse.json({ error: '未找到配置档' }, { status: 404 })

  const lockKey = `${profileId}:${action}`
  if (inFlightActions.has(lockKey)) {
    return NextResponse.json({ error: '这个配置档操作正在执行，请稍后再试' }, { status: 409 })
  }

  inFlightActions.add(lockKey)
  try {
    const result = await runProfileAction(profile, action as OpenClawProfileAction)
    auditProfileAction(auth.actor, profileId, action, result.ok)
    return NextResponse.json({ result }, { status: result.ok ? 200 : 502 })
  } finally {
    inFlightActions.delete(lockKey)
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
  ].flatMap((host) => host.split(','))

  return rawCandidates.some(isLoopbackHost)
}

function auditProfileAction(actor: string, profile: string, action: string, ok: boolean) {
  try {
    const db = getDatabase()
    db.prepare('INSERT INTO audit_log (action, actor, detail) VALUES (?, ?, ?)').run(
      'openclaw.profile.action',
      actor,
      JSON.stringify({ profile, action, ok }),
    )
  } catch {
    // Non-critical for local deployments and tests.
  }
}
