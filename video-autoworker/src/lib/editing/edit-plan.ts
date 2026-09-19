import { createHash } from 'node:crypto'
import { z } from 'zod'

export const editPlanSchemaVersion = 1 as const

const safeIdentifier = z.string().trim().min(1).max(160)

export const rationalSchema = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
}).strict()

export const frameRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  endExclusive: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.endExclusive <= value.start) {
    context.addIssue({ code: 'custom', path: ['endExclusive'], message: '帧区间必须为左闭右开且长度大于零' })
  }
})

export const editAssetRefSchema = z.object({
  assetId: safeIdentifier,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  revision: safeIdentifier,
  sourcePathRef: safeIdentifier.optional(),
  resolveMediaPoolItemUniqueId: safeIdentifier.optional(),
}).strict()

export const editEvidenceRefSchema = z.object({
  evidenceId: safeIdentifier,
  assetId: safeIdentifier,
  revision: safeIdentifier,
  source: z.enum(['saved-summary', 'transcript', 'director-knowledge', 'user']),
  sourceRange: frameRangeSchema.optional(),
  completeness: z.enum(['complete', 'incomplete', 'unknown']).default('unknown'),
}).strict()

export const editClipSchema = z.object({
  itemId: safeIdentifier,
  asset: editAssetRefSchema,
  evidence: z.array(editEvidenceRefSchema).min(1).max(100),
  sourceRange: frameRangeSchema,
  timelineStartFrame: z.number().int().nonnegative(),
  trackIndex: z.number().int().min(1).max(999),
  mediaType: z.enum(['video', 'audio', 'av']).default('av'),
  rationale: z.string().trim().min(1).max(2_000),
}).strict()

export const resolveProjectBaselineSchema = z.object({
  editorNodeId: safeIdentifier,
  resolveVersion: safeIdentifier,
  projectUniqueId: safeIdentifier,
  timelineUniqueId: safeIdentifier.optional(),
  timelineName: z.string().trim().min(1).max(240),
  projectFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  timelineFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
}).strict()

export const editPlanSchema = z.object({
  schemaVersion: z.literal(editPlanSchemaVersion),
  planId: safeIdentifier,
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'validated', 'approved', 'blocked']),
  scope: z.object({ tenantId: z.number().int().positive(), workspaceId: z.number().int().positive() }).strict(),
  sourceTaskIds: z.array(safeIdentifier).min(1).max(100),
  objective: z.string().trim().min(1).max(4_000),
  sourceFrameRate: rationalSchema,
  timelineFrameRate: rationalSchema,
  audioSampleRate: z.number().int().positive().optional(),
  base: resolveProjectBaselineSchema,
  clips: z.array(editClipSchema).max(2_000),
  output: z.object({
    preview: z.boolean().default(true),
    renderPreset: z.string().trim().min(1).max(240).optional(),
    outputPathRef: safeIdentifier.optional(),
  }).strict(),
  capabilitiesRequired: z.array(safeIdentifier).max(100),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
}).strict()

export type EditPlan = z.infer<typeof editPlanSchema>
export type EditClip = z.infer<typeof editClipSchema>
export type FrameRange = z.infer<typeof frameRangeSchema>
export type ResolveProjectBaseline = z.infer<typeof resolveProjectBaselineSchema>

export type EditPlanInput = Omit<EditPlan, 'planSha256'> & { planSha256?: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

export function editPlanDigest(value: Omit<EditPlan, 'planSha256'> | EditPlan): string {
  const copy = { ...value } as Record<string, unknown>
  delete copy.planSha256
  return createHash('sha256').update(canonicalJson(copy)).digest('hex')
}

export function createEditPlan(input: EditPlanInput): EditPlan {
  const parsed = editPlanSchema.parse({
    ...input,
    schemaVersion: editPlanSchemaVersion,
    planSha256: input.planSha256 || '0'.repeat(64),
  })
  const plan = { ...parsed, planSha256: editPlanDigest(parsed) }
  return editPlanSchema.parse(plan)
}

export function assertEditPlanIntegrity(plan: unknown): EditPlan {
  const parsed = editPlanSchema.parse(plan)
  if (editPlanDigest(parsed) !== parsed.planSha256) throw new Error('edit_plan_integrity_mismatch')
  return parsed
}

export function rationalToNumber(value: z.infer<typeof rationalSchema>): number {
  return value.numerator / value.denominator
}

export function frameRangeDuration(range: FrameRange): number {
  return range.endExclusive - range.start
}

export function frameRangeSeconds(range: FrameRange, frameRate: z.infer<typeof rationalSchema>): number {
  return frameRangeDuration(range) * frameRate.denominator / frameRate.numerator
}

export function editPlanIdempotencyKey(
  plan: Pick<EditPlan, 'planId' | 'revision'>,
  phase: string,
  stepId: string,
): string {
  const value = plan.planId + ':' + plan.revision + ':' + phase + ':' + stepId
  return 'resolve-edit:' + createHash('sha256').update(value).digest('hex')
}

export type ResolveCapabilitySnapshot = {
  connected: boolean
  nodeId: string
  resolveVersion: string
  studio: boolean
  capabilities: string[]
  projectUniqueId?: string
  timelineUniqueId?: string
}

export type EditPlanPreflight = {
  ok: boolean
  code: string | null
  warnings: string[]
  requiredCapabilities: string[]
}

export function preflightEditPlan(
  plan: EditPlan,
  snapshot: ResolveCapabilitySnapshot,
): EditPlanPreflight {
  const warnings: string[] = []
  const missing = plan.capabilitiesRequired.filter(capability => !snapshot.capabilities.includes(capability))
  if (!snapshot.connected) return { ok: false, code: 'resolve_executor_unavailable', warnings, requiredCapabilities: missing }
  if (!snapshot.studio) return { ok: false, code: 'resolve_studio_required', warnings, requiredCapabilities: missing }
  if (missing.length) return { ok: false, code: 'resolve_capability_missing', warnings, requiredCapabilities: missing }
  if (snapshot.nodeId !== plan.base.editorNodeId) return { ok: false, code: 'resolve_node_identity_mismatch', warnings, requiredCapabilities: [] }
  if (snapshot.projectUniqueId !== plan.base.projectUniqueId) return { ok: false, code: 'resolve_project_identity_mismatch', warnings, requiredCapabilities: [] }
  if (plan.base.timelineUniqueId && snapshot.timelineUniqueId !== plan.base.timelineUniqueId) {
    return { ok: false, code: 'resolve_timeline_identity_mismatch', warnings, requiredCapabilities: [] }
  }
  if (plan.clips.some(clip => clip.evidence.some(evidence => evidence.completeness !== 'complete'))) {
    warnings.push('plan_contains_incomplete_or_unknown_evidence')
  }
  return { ok: true, code: null, warnings, requiredCapabilities: [] }
}
