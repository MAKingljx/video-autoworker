import { NextRequest, NextResponse } from 'next/server'
import { listN8nExecutions, requireN8nRole } from '@/lib/n8n'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limit = Number(request.nextUrl.searchParams.get('limit') || '20')
  try {
    const executions = await listN8nExecutions(limit)
    return NextResponse.json({ executions }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取执行记录失败' }, { status: 502 })
  }
}
