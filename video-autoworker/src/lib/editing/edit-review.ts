import { randomBytes } from 'node:crypto'
import type { EditPlan } from './edit-plan'
import type { N8nTaskScope } from '@/lib/n8n-task-runs'

// Ephemeral confirmation handles. The approved plan and task remain durable
// in the existing database; a server restart simply requires a fresh review.
const handles = new Map<string, { planId: string; revision: number; sha: string; scope: string; actor: string; expires: number; taskId?: string }>()
const scopeKey = (scope: N8nTaskScope) => `${scope.tenantId}:${scope.workspaceId}`
export function isEditReviewBrowser(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')
  return (site === 'same-origin' || site === 'none') && (!origin || origin === new URL(request.url).origin)
}
export function issueEditReviewToken(plan: EditPlan, scope: N8nTaskScope, actor: string) {
  for (const [key, value] of handles) if (value.expires < Date.now()) handles.delete(key)
  if (handles.size >= 1000) throw new Error('edit_review_capacity_reached')
  const token = randomBytes(32).toString('hex')
  handles.set(token, { planId: plan.planId, revision: plan.revision, sha: plan.planSha256,
    scope: scopeKey(scope), actor, expires: Date.now() + 30 * 60_000 })
  return token
}
export function verifyEditReviewToken(token: string, value: { planId: string; revision: number; expectedPlanSha256: string; taskId: string }, scope: N8nTaskScope, actor: string) {
  const handle = handles.get(token)
  if (!handle || handle.expires < Date.now() || handle.actor !== actor || handle.scope !== scopeKey(scope)
    || handle.planId !== value.planId || handle.revision !== value.revision || handle.sha !== value.expectedPlanSha256
    || (handle.taskId && handle.taskId !== value.taskId)) throw new Error('edit_review_expired_or_changed')
  return () => { handle.taskId = value.taskId }
}
