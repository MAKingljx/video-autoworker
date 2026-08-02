import type Database from 'better-sqlite3'
import { z } from 'zod'
import { normalizeN8nWebhookPath } from '@/lib/n8n'
import { validateN8nModelRoutingConfig } from '@/lib/n8n-model-routing'

export interface N8nWorkflowBinding {
  id: number
  name: string
  description: string
  workflowId: string
  webhookPath: string
  taskType: string
  agentRole: string
  model: string
  timeoutSeconds: number
  retryCount: number
  enabled: boolean
  config: Record<string, unknown>
  createdBy: string
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastStatus: string | null
}

export interface N8nWorkflowScope {
  workspaceId: number
  tenantId: number
}

interface BindingRow {
  id: number
  name: string
  description: string | null
  workflow_id: string | null
  webhook_path: string
  task_type: string
  agent_role: string
  model: string
  timeout_seconds: number
  retry_count: number
  enabled: number
  config: string
  workspace_id: number
  tenant_id: number
  created_by: string
  created_at: number
  updated_at: number
  last_run_at: number | null
  last_status: string | null
}

const SENSITIVE_CONFIG_KEYS = new Set([
  'password', 'passwd', 'secret', 'apikey', 'api_key', 'access_token',
  'accesstoken', 'refresh_token', 'refreshtoken', 'authorization',
  'credential', 'credentials', 'cookie',
])

function findSensitiveConfigPath(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveConfigPath(value[index], [...path, String(index)])
      if (found) return found
    }
    return null
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key]
    if (SENSITIVE_CONFIG_KEYS.has(key.toLowerCase())) return nextPath.join('.')
    const found = findSensitiveConfigPath(child, nextPath)
    if (found) return found
  }
  return null
}

export const n8nWorkflowBindingInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(''),
  workflowId: z.string().trim().max(120).default(''),
  webhookPath: z.string().trim().min(1).max(240),
  taskType: z.string().trim().min(1).max(80).default('general'),
  agentRole: z.string().trim().min(1).max(80).default('executor'),
  model: z.string().trim().min(1).max(180).default('qwen36-tools-local/default_model'),
  timeoutSeconds: z.coerce.number().int().min(5).max(120).default(30),
  retryCount: z.coerce.number().int().min(0).max(10).default(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, ctx) => {
  const sensitivePath = findSensitiveConfigPath(value.config)
  if (sensitivePath) {
    ctx.addIssue({
      code: 'custom',
      path: ['config', ...sensitivePath.split('.')],
      message: '高级配置不能保存密码、密钥、令牌或凭据；请只保存外部密钥引用',
    })
  }
  for (const issue of validateN8nModelRoutingConfig(value.config)) {
    ctx.addIssue({
      code: 'custom',
      path: ['config', 'modelRouting', ...issue.path],
      message: issue.message,
    })
  }
})

export type N8nWorkflowBindingInput = z.infer<typeof n8nWorkflowBindingInputSchema>

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function rowToBinding(row: BindingRow): N8nWorkflowBinding {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    workflowId: row.workflow_id || '',
    webhookPath: row.webhook_path,
    taskType: row.task_type,
    agentRole: row.agent_role,
    model: row.model,
    timeoutSeconds: row.timeout_seconds,
    retryCount: row.retry_count,
    enabled: row.enabled === 1,
    config: parseConfig(row.config),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
  }
}

function normalizeInput(input: N8nWorkflowBindingInput): N8nWorkflowBindingInput {
  return {
    ...input,
    webhookPath: normalizeN8nWebhookPath(input.webhookPath),
  }
}

export function listN8nWorkflowBindings(
  db: Database.Database,
  scope: N8nWorkflowScope,
): N8nWorkflowBinding[] {
  const rows = db.prepare(`
    SELECT * FROM n8n_workflow_bindings
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY enabled DESC, updated_at DESC, id DESC
  `).all(scope.tenantId, scope.workspaceId) as BindingRow[]
  return rows.map(rowToBinding)
}

export function getN8nWorkflowBinding(
  db: Database.Database,
  id: number,
  scope: N8nWorkflowScope,
): N8nWorkflowBinding | null {
  const row = db.prepare(`
    SELECT * FROM n8n_workflow_bindings
    WHERE id = ? AND tenant_id = ? AND workspace_id = ?
  `).get(id, scope.tenantId, scope.workspaceId) as BindingRow | undefined
  return row ? rowToBinding(row) : null
}

export function createN8nWorkflowBinding(
  db: Database.Database,
  rawInput: N8nWorkflowBindingInput,
  actor: string,
  scope: N8nWorkflowScope,
): N8nWorkflowBinding {
  const input = normalizeInput(rawInput)
  const result = db.prepare(`
    INSERT INTO n8n_workflow_bindings (
      name, description, workflow_id, webhook_path, task_type, agent_role,
      model, timeout_seconds, retry_count, enabled, config, workspace_id,
      tenant_id, created_by,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(
    input.name,
    input.description,
    input.workflowId || null,
    input.webhookPath,
    input.taskType,
    input.agentRole,
    input.model,
    input.timeoutSeconds,
    input.retryCount,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    scope.workspaceId,
    scope.tenantId,
    actor,
  )
  return getN8nWorkflowBinding(db, Number(result.lastInsertRowid), scope)!
}

export function updateN8nWorkflowBinding(
  db: Database.Database,
  id: number,
  rawInput: N8nWorkflowBindingInput,
  scope: N8nWorkflowScope,
): N8nWorkflowBinding | null {
  if (!getN8nWorkflowBinding(db, id, scope)) return null
  const input = normalizeInput(rawInput)
  db.prepare(`
    UPDATE n8n_workflow_bindings SET
      name = ?, description = ?, workflow_id = ?, webhook_path = ?,
      task_type = ?, agent_role = ?, model = ?, timeout_seconds = ?,
      retry_count = ?, enabled = ?, config = ?, updated_at = unixepoch()
    WHERE id = ? AND tenant_id = ? AND workspace_id = ?
  `).run(
    input.name,
    input.description,
    input.workflowId || null,
    input.webhookPath,
    input.taskType,
    input.agentRole,
    input.model,
    input.timeoutSeconds,
    input.retryCount,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    id,
    scope.tenantId,
    scope.workspaceId,
  )
  return getN8nWorkflowBinding(db, id, scope)
}

export function deleteN8nWorkflowBinding(
  db: Database.Database,
  id: number,
  scope: N8nWorkflowScope,
): boolean {
  return db.prepare(`
    DELETE FROM n8n_workflow_bindings
    WHERE id = ? AND tenant_id = ? AND workspace_id = ?
  `).run(id, scope.tenantId, scope.workspaceId).changes > 0
}

export function updateN8nWorkflowRunStatus(
  db: Database.Database,
  id: number,
  status: string,
  scope: N8nWorkflowScope,
): void {
  db.prepare(`
    UPDATE n8n_workflow_bindings
    SET last_run_at = unixepoch(), last_status = ?, updated_at = unixepoch()
    WHERE id = ? AND tenant_id = ? AND workspace_id = ?
  `).run(status.slice(0, 120), id, scope.tenantId, scope.workspaceId)
}
