import { createHash } from 'node:crypto'
import { z } from 'zod'
import { n8nModelRouteSchema, type N8nModelRoute } from '@/lib/n8n-model-routing'

// The request and its checkpoint identity must use the same system message.
export const MEDIA_ANALYSIS_SYSTEM_PROMPT = '你是无状态视频分析工作节点，只处理当前请求，不读取或写入任何会话记忆。'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const generationSchema = z.object({
  phase: z.enum(['vision', 'chapter', 'final']),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'xhigh']),
  maxTokens: z.number().int().min(1).max(131_072),
}).strict()

/**
 * maxTokens identifies the per-segment generation policy, not the aggregate
 * token limit of a transport batch. Regrouping missing segments must not
 * invalidate an otherwise unchanged, independently validated segment.
 */
export type MediaCheckpointGenerationIdentity = z.infer<typeof generationSchema>

export const mediaCheckpointModelIdentitySchema = z.object({
  schema: z.literal('aiworker-media-model-identity/v1'),
  assurance: z.enum(['model-revision', 'request-configuration']),
  routeId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/u),
  model: z.string().trim().min(1).max(180),
  configurationSha256: sha256Schema,
  modelRevisionSha256: sha256Schema.nullable(),
}).strict().superRefine((identity, context) => {
  if ((identity.assurance === 'model-revision') !== (identity.modelRevisionSha256 !== null)) {
    context.addIssue({ code: 'custom', message: 'model_identity_assurance_mismatch' })
  }
})

export type MediaCheckpointModelIdentity = z.infer<typeof mediaCheckpointModelIdentitySchema>
type CompatibleRoute = Extract<N8nModelRoute, { transport: 'openai-compatible' }>

const optionsSchema = z.object({
  systemPrompt: z.string().max(4_000).optional(),
}).strict()
export type MediaCheckpointIdentityOptions = z.infer<typeof optionsSchema>

/**
 * A model alias and endpoint are request provenance, never proof of weights.
 * Without an operator-verified revision this identity explicitly records only
 * the immutable request configuration. It is suitable for same-task segment
 * reuse alongside source/frame/prompt/output hashes; it must not be presented
 * as a portable proof that the underlying model weights stayed unchanged.
 */
export function createMediaCheckpointModelIdentity(
  route: CompatibleRoute,
  generation: MediaCheckpointGenerationIdentity,
  options: MediaCheckpointIdentityOptions = {},
): MediaCheckpointModelIdentity {
  const parsedRoute = n8nModelRouteSchema.parse(route)
  if (parsedRoute.transport !== 'openai-compatible') throw new TypeError('media_checkpoint_transport_invalid')
  const parsedGeneration = generationSchema.parse(generation)
  const parsedOptions = optionsSchema.parse(options)
  const revision = parsedRoute.modelRevisionSha256 ?? null
  const configuration = {
    schema: 'aiworker-media-request-configuration/v1',
    routeId: parsedRoute.id,
    transport: parsedRoute.transport,
    model: parsedRoute.model,
    endpoint: `${parsedRoute.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    credentialReference: parsedRoute.apiKeyEnv ?? null,
    temperature: parsedRoute.temperature ?? null,
    systemPrompt: parsedOptions.systemPrompt ?? MEDIA_ANALYSIS_SYSTEM_PROMPT,
    generation: {
      phase: parsedGeneration.phase,
      reasoningEffort: parsedGeneration.reasoningEffort,
      maxTokens: parsedGeneration.maxTokens,
    },
    modelRevisionSha256: revision,
  }
  return mediaCheckpointModelIdentitySchema.parse({
    schema: 'aiworker-media-model-identity/v1',
    assurance: revision ? 'model-revision' : 'request-configuration',
    routeId: parsedRoute.id,
    model: parsedRoute.model,
    configurationSha256: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    modelRevisionSha256: revision,
  })
}

export function matchesMediaCheckpointModelIdentity(
  value: unknown,
  route: CompatibleRoute,
  generation: MediaCheckpointGenerationIdentity,
  options: MediaCheckpointIdentityOptions = {},
): value is MediaCheckpointModelIdentity {
  const parsed = mediaCheckpointModelIdentitySchema.safeParse(value)
  if (!parsed.success) return false
  const expected = createMediaCheckpointModelIdentity(route, generation, options)
  return parsed.data.assurance === expected.assurance
    && parsed.data.routeId === expected.routeId
    && parsed.data.model === expected.model
    && parsed.data.configurationSha256 === expected.configurationSha256
    && parsed.data.modelRevisionSha256 === expected.modelRevisionSha256
}
