import { NextRequest, NextResponse } from 'next/server'
import { checkN8nHealth, getN8nRuntimeConfig, listN8nRemoteWorkflows, requireN8nRole } from '@/lib/n8n'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const health = await checkN8nHealth()
  let remoteWorkflows: Awaited<ReturnType<typeof listN8nRemoteWorkflows>> = []
  let managementError: string | null = null
  if (health.apiKeyConfigured) {
    try {
      remoteWorkflows = await listN8nRemoteWorkflows()
    } catch (error) {
      managementError = error instanceof Error ? error.message : '无法读取 n8n 工作流'
    }
  }

  return NextResponse.json({
    health,
    config: getN8nRuntimeConfig(),
    remoteWorkflows,
    managementError,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
