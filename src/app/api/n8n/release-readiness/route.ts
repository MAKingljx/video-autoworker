import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nGlobalReleaseManager } from '@/lib/n8n-global-release-auth'
import { getN8nIntakeControl } from '@/lib/n8n-intake-control'
import { getSchedulerLeadershipStatus } from '@/lib/scheduler'
import {
  directorEvidenceProjectionContractDigest,
  getDirectorEvidenceOutboxCounts,
} from '@/lib/director-evidence-outbox'
import {
  buildN8nReleaseReadiness,
  getN8nRollingDatabaseCompatibility,
  getN8nRuntimeDrainStatus,
  resolveN8nRuntimeIdentity,
} from '@/lib/n8n-runtime-affinity'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  const auth = requireN8nGlobalReleaseManager(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let runtime
  try {
    runtime = resolveN8nRuntimeIdentity()
  } catch {
    return NextResponse.json({
      code: 'RELEASE_RUNTIME_INVALID',
      error: '当前运行版本身份无效',
    }, { status: 503, headers: NO_STORE_HEADERS })
  }
  if (!runtime) {
    return NextResponse.json({
      code: 'RELEASE_RUNTIME_UNATTRIBUTABLE',
      error: '当前不是可跟踪的蓝绿 slot 运行时',
    }, { status: 409, headers: NO_STORE_HEADERS })
  }

  try {
    const db = getDatabase()
    const database = getN8nRollingDatabaseCompatibility(db)
    const outbox = getDirectorEvidenceOutboxCounts(db)
    const control = getN8nIntakeControl(db)
    if (control.accepting) {
      return NextResponse.json({
        code: 'RELEASE_INTAKE_ACTIVE',
        error: '全局任务入口仍在接收新任务',
      }, { status: 409, headers: NO_STORE_HEADERS })
    }
    return NextResponse.json({
      readiness: buildN8nReleaseReadiness(
        control,
        runtime,
        getN8nRuntimeDrainStatus(db, runtime),
        getSchedulerLeadershipStatus(),
        database,
        {
          schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
          contractDigest: directorEvidenceProjectionContractDigest(),
          pending: outbox.pending,
          incompatiblePending: outbox.incompatiblePending,
          deliveredWithoutValidReceipt: outbox.deliveredWithoutValidReceipt,
          outOfScopeOutbox: outbox.outOfScopeOutbox,
          outOfScopeExtraction: outbox.outOfScopeExtraction,
        },
      ),
    }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json({
      code: 'RELEASE_READINESS_UNAVAILABLE',
      error: '无法读取发布就绪状态',
    }, { status: 503, headers: NO_STORE_HEADERS })
  }
}
