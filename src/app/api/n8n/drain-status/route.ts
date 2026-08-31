import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nGlobalReleaseManager } from '@/lib/n8n-global-release-auth'
import {
  getN8nRuntimeDrainStatus,
  resolveN8nRuntimeIdentity,
} from '@/lib/n8n-runtime-affinity'

export async function GET(request: NextRequest) {
  const auth = requireN8nGlobalReleaseManager(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let runtime
  try {
    runtime = resolveN8nRuntimeIdentity()
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '运行版本身份无效',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!runtime) {
    return NextResponse.json({
      error: '当前不是可跟踪的蓝绿 slot 运行时',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  try {
    return NextResponse.json({
      drain: getN8nRuntimeDrainStatus(getDatabase(), runtime),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({
      error: '无法读取当前运行版本的退役状态',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
