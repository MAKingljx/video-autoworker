import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { videoEditingEnabled, inspectVideoEditingSchema } from '@/lib/database-capabilities'
import { createUnixResolveExecutorTransport } from '@/lib/editing/resolve-executor-transport'
import { editingSocketPath } from '@/lib/editing/edit-task-runner'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const db = getDatabase()
  let schemaReady = false
  let errorCode: string | null = null
  try { schemaReady = inspectVideoEditingSchema(db, false) } catch { errorCode = 'VIDEO_EDIT_SCHEMA_INVALID' }
  const bindings = db.prepare(`SELECT id FROM n8n_workflow_bindings WHERE task_type='video-edit' AND enabled=1
    AND tenant_id=? AND workspace_id=? LIMIT 2`).all(auth.user.tenant_id, auth.user.workspace_id) as Array<{ id: number }>
  let executor = null
  try { executor = await createUnixResolveExecutorTransport({ socketPath: editingSocketPath() }).inspect() }
  catch { errorCode ||= 'RESOLVE_NOT_CONNECTED' }
  const writeAuth = requireN8nRole(new Request(new URL('/api/editing/plans', request.url), { method: 'POST', headers: request.headers }), 'operator')
  const enabled = videoEditingEnabled()
  const canWrite = enabled && schemaReady && bindings.length === 1 && Boolean(executor?.connected) && !('error' in writeAuth)
  return NextResponse.json({ enabled, schemaReady, executor, errorCode,
    bindingId: bindings.length === 1 ? bindings[0].id : null, canApprove: canWrite, canCancel: enabled && schemaReady && !('error' in writeAuth) },
  { headers: { 'Cache-Control': 'no-store' } })
}
