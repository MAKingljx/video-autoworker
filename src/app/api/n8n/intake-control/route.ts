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
import { acquireSharedDeploymentLock } from '@/lib/shared-deployment-lock'
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

  let lease: Awaited<ReturnType<typeof acquireSharedDeploymentLock>> | null = null
  try {
    lease = await acquireSharedDeploymentLock()
  } catch {
    return NextResponse.json({
      code: 'DEPLOYMENT_LOCK_UNAVAILABLE',
      error: '无法安全取得发布锁，任务入口保持原状态，请检查运行目录后重试',
    }, { status: 503, headers: NO_STORE_HEADERS })
  }
  if (!lease.acquired) {
    return NextResponse.json({
      code: 'DEPLOYMENT_IN_PROGRESS',
      error: '共享组件正在解析、发布或补偿，任务入口暂不能变更',
    }, { status: 423, headers: NO_STORE_HEADERS })
  }

  let result: ReturnType<typeof setN8nIntakeControl>
  let releaseFailed = false
  try {
    result = setN8nIntakeControl(getDatabase(), parsed.data, {
      id: auth.user.id,
      name: auth.user.username,
    })
  } finally {
    if (lease?.acquired) {
      try { lease.lease.release() } catch { releaseFailed = true }
    }
  }
  if (releaseFailed) {
    return NextResponse.json({
      code: 'DEPLOYMENT_LOCK_RELEASE_FAILED',
      error: '入口状态已完成事务处理，但发布锁释放失败；请刷新状态并人工检查锁目录',
      control: { ...result.control, canManage: true },
    }, { status: 503, headers: NO_STORE_HEADERS })
  }
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
