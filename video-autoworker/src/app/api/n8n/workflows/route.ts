import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  createN8nWorkflowBinding,
  deleteN8nWorkflowBinding,
  listN8nWorkflowBindings,
  n8nWorkflowBindingInputSchema,
  updateN8nWorkflowBinding,
} from '@/lib/n8n-workflows'
import { mutationLimiter } from '@/lib/rate-limit'

function parseId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  return NextResponse.json({ bindings: listN8nWorkflowBindings(getDatabase(), scope) }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const body = await request.json().catch(() => null)
  const parsed = n8nWorkflowBindingInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '任务链配置无效', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
    const binding = createN8nWorkflowBinding(getDatabase(), parsed.data, auth.user.username, scope)
    try {
      logAuditEvent({ action: 'n8n_binding_create', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: binding.id, detail: { name: binding.name } })
    } catch {
      // The mutation already succeeded; an audit write failure must not invite a duplicate retry.
    }
    return NextResponse.json({ binding }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '创建任务链失败' }, { status: 400 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const id = parseId(body?.id)
  if (!id) return NextResponse.json({ error: '缺少有效的任务链 ID' }, { status: 400 })
  const parsed = n8nWorkflowBindingInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '任务链配置无效', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
    const binding = updateN8nWorkflowBinding(getDatabase(), id, parsed.data, scope)
    if (!binding) return NextResponse.json({ error: '未找到任务链' }, { status: 404 })
    try {
      logAuditEvent({ action: 'n8n_binding_update', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: id, detail: { name: binding.name } })
    } catch {
      // The mutation already succeeded; an audit write failure must not invite a duplicate retry.
    }
    return NextResponse.json({ binding })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '更新任务链失败' }, { status: 400 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const id = parseId(request.nextUrl.searchParams.get('id'))
  if (!id) return NextResponse.json({ error: '缺少有效的任务链 ID' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  if (!deleteN8nWorkflowBinding(getDatabase(), id, scope)) {
    return NextResponse.json({ error: '未找到任务链' }, { status: 404 })
  }
  try {
    logAuditEvent({ action: 'n8n_binding_delete', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: id })
  } catch {
    // The mutation already succeeded; an audit write failure must not invite a duplicate retry.
  }
  return NextResponse.json({ deleted: id })
}
