import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireN8nGlobalReleaseManager } from '@/lib/n8n-global-release-auth'
import { isOpenClawLoopbackAuthMode } from '@/lib/openclaw-loopback-auth'
import { getSchedulerLeadershipStatus, getSchedulerStatus, triggerTask } from '@/lib/scheduler'
import { getExternalSchedulerStatus, requestSchedulerWorker } from '@/lib/scheduler-worker-ipc'

/**
 * GET /api/scheduler - Get scheduler status
 */
export async function GET(request: NextRequest) {
  const auth = isOpenClawLoopbackAuthMode()
    ? requireN8nGlobalReleaseManager(request)
    : requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  if (process.env.AIWORKER_SCHEDULER_STATE_DIR) {
    try {
      return NextResponse.json({ ...await getExternalSchedulerStatus(),
        webLeadership: getSchedulerLeadershipStatus() }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch {
      return NextResponse.json({ error: 'scheduler_worker_unavailable' }, { status: 503 })
    }
  }
  return NextResponse.json({
    leadership: getSchedulerLeadershipStatus(),
    tasks: getSchedulerStatus(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * POST /api/scheduler - Manually trigger a scheduled task
 * Body: { task_id: 'auto_backup' | 'auto_cleanup' | 'agent_heartbeat' }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json().catch(() => ({}))
  const taskId = typeof body?.task_id === 'string' ? body.task_id : ''
  if (process.env.AIWORKER_SCHEDULER_STATE_DIR) {
    try {
      const status = await getExternalSchedulerStatus()
      if (!status.healthy) return NextResponse.json({ error: 'scheduler_worker_unavailable' }, { status: 503 })
      if (!status.tasks.some((task: { id: string }) => task.id === taskId)) {
        return NextResponse.json({ error: 'scheduler_worker_task_invalid' }, { status: 400 })
      }
      const result = await requestSchedulerWorker('/trigger', { task_id: taskId }, { timeoutMs: 0 })
      return NextResponse.json(result, { status: result.ok ? 200 : 500 })
    } catch {
      return NextResponse.json({ error: 'scheduler_worker_unavailable' }, { status: 503 })
    }
  }
  const allowedTaskIds = new Set(getSchedulerStatus().map((task) => task.id))

  if (!taskId || !allowedTaskIds.has(taskId)) {
    return NextResponse.json({
      error: `task_id required: ${Array.from(allowedTaskIds).join(', ')}`,
    }, { status: 400 })
  }

  const result = await triggerTask(taskId)
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
