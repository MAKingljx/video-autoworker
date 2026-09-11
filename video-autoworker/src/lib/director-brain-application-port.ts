import { z } from 'zod'

const record = z.record(z.string(), z.unknown())
export const DIRECTOR_BRAIN_APPLICATION_PROTOCOL = 'director-brain-application/v1'
const queryActions = [
  'health', 'explain', 'resolve_work', 'get', 'get_many', 'search', 'assemble',
  'workflow', 'learning_context',
] as const
const reviewBatchTarget = z.object({
  table: z.string().trim().min(1).max(64),
  stableId: z.string().trim().min(1).max(160),
  workId: z.string().trim().min(1).max(160).nullable().optional(),
  state: z.string().trim().min(1).max(32),
  version: z.string().regex(/^v\d+\.\d+\.\d+$/u),
  targetStatuses: z.array(z.string().trim().min(1).max(32)).min(1).max(3),
  name: z.string().max(240).optional(),
  workName: z.string().max(80).optional(),
  start: z.string().max(32).optional(),
  end: z.string().max(32).optional(),
  summary: z.string().max(2_000).optional(),
}).strict()
const reviewBatchInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('prepare'), actorKey: z.string().min(1).max(512),
    requestKey: z.string().min(1).max(240), decision: z.enum(['approve', 'reject']),
    targets: z.array(reviewBatchTarget).min(1).max(50),
  }).strict(),
  z.object({
    action: z.literal('claim'), actorKey: z.string().min(1).max(512),
    confirmationCode: z.string().regex(/^[A-Z0-9]{6,12}$/u),
    decision: z.enum(['approve', 'reject']),
    count: z.number().int().min(1).max(50),
  }).strict(),
  z.object({
    action: z.literal('record'), actorKey: z.string().min(1).max(512),
    batchId: z.string().trim().min(1).max(80), ordinal: z.number().int().min(0).max(49),
    status: z.enum(['completed', 'unknown', 'failed', 'stale']),
    resultVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u).optional(),
    errorCode: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/u).optional(),
  }).strict(),
  z.object({
    action: z.literal('cancel'), actorKey: z.string().min(1).max(512),
    confirmationCode: z.string().regex(/^[A-Z0-9]{6,12}$/u),
  }).strict(),
])
export type DirectorReviewBatchApplicationInput = z.infer<typeof reviewBatchInput>

export const directorBrainApplicationRequestSchema = z.discriminatedUnion('command', [
  z.object({
    protocol: z.literal(DIRECTOR_BRAIN_APPLICATION_PROTOCOL).optional(),
    command: z.literal('operate'),
    input: record.and(z.object({ action: z.enum(queryActions) })),
  }).strict(),
  z.object({
    protocol: z.literal(DIRECTOR_BRAIN_APPLICATION_PROTOCOL).optional(),
    command: z.literal('propose'),
    input: record.and(z.object({ action: z.literal('propose') })),
  }).strict(),
  z.object({
    protocol: z.literal(DIRECTOR_BRAIN_APPLICATION_PROTOCOL).optional(),
    command: z.literal('review'),
    input: record,
  }).strict(),
  z.object({
    protocol: z.literal(DIRECTOR_BRAIN_APPLICATION_PROTOCOL).optional(),
    command: z.literal('review-batch'),
    input: reviewBatchInput,
  }).strict(),
]).transform(value => Object.freeze({
  ...value,
  protocol: DIRECTOR_BRAIN_APPLICATION_PROTOCOL,
  input: Object.freeze({ ...value.input }),
}))

export type DirectorBrainApplicationRequest = z.infer<
  typeof directorBrainApplicationRequestSchema
>

export interface DirectorBrainApplicationPort {
  query(input: Record<string, unknown>): Promise<Record<string, unknown>>
  propose(input: Record<string, unknown>): Promise<Record<string, unknown>>
  review(input: Record<string, unknown>): Promise<Record<string, unknown>>
  reviewBatch(input: DirectorReviewBatchApplicationInput): Promise<Record<string, unknown>>
}

export function parseDirectorBrainApplicationRequest(
  value: unknown,
): DirectorBrainApplicationRequest | null {
  const legacy = value && typeof value === 'object' && !Array.isArray(value)
    && !Object.hasOwn(value, 'protocol')
    && (value as Record<string, unknown>).command === 'operate'
    && (value as { input?: { action?: unknown } }).input?.action === 'propose'
    ? { ...(value as Record<string, unknown>), command: 'propose' }
    : value
  const parsed = directorBrainApplicationRequestSchema.safeParse(legacy)
  return parsed.success ? parsed.data : null
}

export async function executeDirectorBrainApplicationRequest(
  port: DirectorBrainApplicationPort,
  request: DirectorBrainApplicationRequest,
): Promise<Record<string, unknown>> {
  if (request.command === 'operate') return await port.query(request.input)
  if (request.command === 'propose') return await port.propose(request.input)
  if (request.command === 'review') return await port.review(request.input)
  return await port.reviewBatch(request.input as DirectorReviewBatchApplicationInput)
}

export function directorBrainCommandPort(
  runner: (command: 'operate' | 'review', input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  reviewBatch: DirectorBrainApplicationPort['reviewBatch'] = async () => {
    throw new Error('director_review_batch_unavailable')
  },
): DirectorBrainApplicationPort {
  return Object.freeze({
    query: (input: Record<string, unknown>) => runner('operate', input),
    propose: (input: Record<string, unknown>) => runner('operate', input),
    review: (input: Record<string, unknown>) => runner('review', input),
    reviewBatch,
  })
}
