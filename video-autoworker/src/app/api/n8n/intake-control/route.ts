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
import {
  acquireSharedDeploymentLock,
  verifySharedDeploymentLockDelegation,
  type SharedDeploymentLockDelegationWitness,
} from '@/lib/shared-deployment-lock'
import { mutationLimiter } from '@/lib/rate-limit'
import { isLoopbackHttpRequest } from '@/lib/openclaw-loopback-auth'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }
const BOOTSTRAP_DRAIN_REASON = '首次蓝绿基线引导期间冻结入口'
const BOOTSTRAP_OWNER_PID_HEADER = 'x-aiworker-bootstrap-lock-owner-pid'
const BOOTSTRAP_OWNER_NONCE_HEADER = 'x-aiworker-bootstrap-lock-nonce'

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

  const delegatedPid = request.headers.get(BOOTSTRAP_OWNER_PID_HEADER)
  const delegatedNonce = request.headers.get(BOOTSTRAP_OWNER_NONCE_HEADER)
  const delegationRequested = delegatedPid !== null || delegatedNonce !== null
  let delegation: SharedDeploymentLockDelegationWitness | null = null
  if (delegationRequested) {
    if (!delegatedPid || !/^[1-9][0-9]*$/u.test(delegatedPid)
      || !delegatedNonce || !/^[a-f0-9]{64}$/u.test(delegatedNonce)
      || !isLoopbackHttpRequest(request)
      || parsed.data.action !== 'drain' || parsed.data.reason !== BOOTSTRAP_DRAIN_REASON) {
      return NextResponse.json({
        code: 'BOOTSTRAP_LOCK_DELEGATION_INVALID',
        error: '引导暂停委托无效，入口状态保持不变',
      }, { status: 403, headers: NO_STORE_HEADERS })
    }
    try {
      delegation = verifySharedDeploymentLockDelegation({
        ownerPid: Number(delegatedPid),
        ownerNonce: delegatedNonce,
      })
    } catch {
      return NextResponse.json({
        code: 'BOOTSTRAP_LOCK_DELEGATION_INVALID',
        error: '无法验证引导暂停委托，入口状态保持不变',
      }, { status: 403, headers: NO_STORE_HEADERS })
    }
  }

  let lease: Awaited<ReturnType<typeof acquireSharedDeploymentLock>> | null = null
  if (!delegation) {
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
  }

  let result: ReturnType<typeof setN8nIntakeControl>
  let releaseFailed = false
  try {
    const database = getDatabase()
    const mutate = () => setN8nIntakeControl(database, parsed.data, {
      id: auth.user.id,
      name: auth.user.username,
    })
    if (delegation) {
      try {
        result = database.transaction(() => {
          delegation.assertCurrent()
          const updated = mutate()
          delegation.assertCurrent()
          return updated
        }).immediate()
      } catch {
        return NextResponse.json({
          code: 'BOOTSTRAP_LOCK_DELEGATION_LOST',
          error: '引导暂停事务失去发布锁委托，写入已回滚',
        }, { status: 503, headers: NO_STORE_HEADERS })
      }
    } else {
      result = mutate()
    }
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
