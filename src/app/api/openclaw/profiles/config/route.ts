import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import {
  assertProfileId,
  getOpenClawProfile,
  readProfileConfigFile,
  restoreProfileConfigFileBackup,
  saveProfileConfigFile,
} from '@/lib/openclaw-profiles'

const fileIdSchema = z.enum([
  'openclaw-json',
  'workspace-rules',
  'workspace-memory',
  'workspace-today-memory',
  'profile-wiki-rules',
]).optional()

const saveSchema = z.object({
  profile: z.string().min(1),
  fileId: fileIdSchema,
  raw: z.string().max(2_000_000),
  hash: z.string().optional(),
})

const restoreSchema = z.object({
  profile: z.string().min(1),
  fileId: fileIdSchema,
  backupName: z.string().min(1).max(255),
  hash: z.string().optional(),
})

export async function GET(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'admin')
  if ('response' in auth) return auth.response

  const profileId = String(request.nextUrl.searchParams.get('profile') || '')
  const parsedFileId = fileIdSchema.safeParse(request.nextUrl.searchParams.get('fileId') || undefined)
  if (!parsedFileId.success) {
    return NextResponse.json({ error: '不支持的核心配置文件' }, { status: 400 })
  }

  try {
    assertProfileId(profileId)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  const profile = getOpenClawProfile(profileId)
  if (!profile) return NextResponse.json({ error: '未找到配置档' }, { status: 404 })

  try {
    const config = await readProfileConfigFile(profile, parsedFileId.data || 'openclaw-json')
    return NextResponse.json({ config }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '读取配置失败' },
      { status: 502 },
    )
  }
}

export async function PUT(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'admin')
  if ('response' in auth) return auth.response

  const parsed = saveSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({
      error: '请求校验失败',
      details: parsed.error.issues.map(formatZodIssue),
    }, { status: 400 })
  }

  try {
    assertProfileId(parsed.data.profile)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  const profile = getOpenClawProfile(parsed.data.profile)
  if (!profile) return NextResponse.json({ error: '未找到配置档' }, { status: 404 })

  try {
    const result = await saveProfileConfigFile(
      profile,
      parsed.data.fileId || 'openclaw-json',
      parsed.data.raw,
      parsed.data.hash,
    )
    return NextResponse.json(
      { result },
      { status: result.ok ? 200 : result.code === 'CONFLICT' ? 409 : 400 },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存配置失败' },
      { status: 502 },
    )
  }
}

export async function POST(request: NextRequest) {
  const auth = authorizeProfilesRequest(request, 'admin')
  if ('response' in auth) return auth.response

  const parsed = restoreSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({
      error: '请求校验失败',
      details: parsed.error.issues.map(formatZodIssue),
    }, { status: 400 })
  }

  try {
    assertProfileId(parsed.data.profile)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  const profile = getOpenClawProfile(parsed.data.profile)
  if (!profile) return NextResponse.json({ error: '未找到配置档' }, { status: 404 })

  try {
    const result = await restoreProfileConfigFileBackup(
      profile,
      parsed.data.fileId || 'openclaw-json',
      parsed.data.backupName,
      parsed.data.hash,
    )
    return NextResponse.json(
      { result },
      { status: result.ok ? 200 : result.code === 'CONFLICT' ? 409 : 400 },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '恢复配置失败' },
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

function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.length ? issue.path.join('.') : '根节点'
  let message = issue.message
  const replacements: Array<[RegExp, string]> = [
    [/Invalid input/gi, '输入无效'],
    [/Required/gi, '必填'],
    [/String must contain at least (\d+) character\(s\)/gi, '至少需要 $1 个字符'],
    [/String must contain at most (\d+) character\(s\)/gi, '最多允许 $1 个字符'],
    [/Too small: expected string to have >=(\d+) characters/gi, '至少需要 $1 个字符'],
    [/Too big: expected string to have <=(\d+) characters/gi, '最多允许 $1 个字符'],
  ]
  for (const [pattern, replacement] of replacements) {
    message = message.replace(pattern, replacement)
  }
  return `${path}：${message}`
}
