import { z } from 'zod'

export const resolveExecutorRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^[0-9a-f-]{36}$/u),
  operationId: z.string().regex(/^resolve-operation:[0-9a-f]{64}$/u),
  action: z.enum(['inspect', 'apply', 'cancel', 'status']),
  planJson: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict()

export const resolveExecutorResponseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^[0-9a-f-]{36}$/u),
  operationId: z.string().regex(/^resolve-operation:[0-9a-f]{64}$/u),
  status: z.enum(['accepted', 'succeeded', 'failed', 'unknown', 'cancelled']),
  errorCode: z.string().regex(/^[a-z0-9_:-]+$/u).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type ResolveExecutorRequest = z.infer<typeof resolveExecutorRequestSchema>
export type ResolveExecutorResponse = z.infer<typeof resolveExecutorResponseSchema>

export function encodeResolveExecutorRequest(request: ResolveExecutorRequest): string {
  return JSON.stringify(resolveExecutorRequestSchema.parse(request)) + '\n'
}

export function decodeResolveExecutorResponse(raw: string): ResolveExecutorResponse {
  return resolveExecutorResponseSchema.parse(JSON.parse(raw))
}
