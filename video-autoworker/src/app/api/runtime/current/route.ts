import { NextRequest, NextResponse } from 'next/server'
import { requireN8nRole } from '@/lib/n8n'
import { getCurrentRuntimeStatus } from '@/lib/runtime-receipt'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json(await getCurrentRuntimeStatus(), { headers: { 'Cache-Control': 'no-store' } })
}
