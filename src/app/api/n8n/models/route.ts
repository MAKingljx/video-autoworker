import { NextRequest, NextResponse } from 'next/server'
import { requireN8nRole } from '@/lib/n8n'
import { loadN8nModelRegistry, publicN8nModelRoute } from '@/lib/n8n-model-routing'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const registry = loadN8nModelRegistry()
  return NextResponse.json({
    routes: registry.routes.map(publicN8nModelRoute),
    source: registry.source,
    errors: registry.errors,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
