import type { N8nTaskRun } from '@/lib/n8n-task-runs'

/** Original task identity and snapshots are reused for first and recovery dispatch. */
export function n8nTaskWebhookPayload(run: N8nTaskRun): Record<string, unknown> {
  return { taskId: run.taskId, idempotencyKey: run.idempotencyKey, source: run.source,
    requestedBy: run.requestedBy, routing: run.routing, input: run.input, delivery: run.delivery }
}
