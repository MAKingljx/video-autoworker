import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import {
  getN8nGlobalReleaseAccess,
  requireN8nGlobalReleaseManager,
} from '@/lib/n8n-global-release-auth'
import {
  getN8nIntakeControl,
  n8nIntakeControlMutationSchema,
  setN8nIntakeControl,
} from '@/lib/n8n-intake-control'
import { mutationLimiter } from '@/lib/rate-limit'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const auth = getN8nGlobalReleaseAccess(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const control = getN8nIntakeControl(getDatabase())
  const responseControl = auth.canManage
    ? { ...control, canManage: true }
    : {
        accepting: control.accepting,
        canManage: false,
      }
  return NextResponse.json({ control: responseControl }, {
    headers: NO_STORE_HEADERS,
  })
}

export async function POST(request: NextRequest) {
  const auth = requireN8nGlobalReleaseManager(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const body = await request.json().catch(() => null)
  const parsed = n8nIntakeControlMutationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({
      error: '入口控制参数无效；必须提供操作、8 至 300 字原因和当前版本',
      issues: parsed.error.issues,
    }, { status: 400 })
  }

  const result = setN8nIntakeControl(getDatabase(), parsed.data, {
    id: auth.user.id,
    name: auth.user.username,
  })
  if (result.outcome === 'conflict') {
    return NextResponse.json({
      code: 'INTAKE_STATE_CONFLICT',
      error: '入口状态已被其他管理员更新，请刷新后重试',
      control: { ...result.control, canManage: true },
    }, { status: 409, headers: NO_STORE_HEADERS })
  }
  return NextResponse.json({
    control: { ...result.control, canManage: true },
  }, { headers: NO_STORE_HEADERS })
}
