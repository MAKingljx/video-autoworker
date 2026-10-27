import { describe, expect, it } from 'vitest'
import type { N8nModelRoute } from '@/lib/n8n-model-routing'
import {
  createMediaCheckpointModelIdentity,
  matchesMediaCheckpointModelIdentity,
  mediaCheckpointModelIdentitySchema,
  MEDIA_ANALYSIS_SYSTEM_PROMPT,
  type MediaCheckpointGenerationIdentity,
} from '@/lib/n8n-media-checkpoint-identity'

type CompatibleRoute = Extract<N8nModelRoute, { transport: 'openai-compatible' }>
const route: CompatibleRoute = {
  id: 'local-vision', label: '本地视觉', location: 'local', transport: 'openai-compatible',
  model: 'vision-model', baseUrl: 'http://127.0.0.1:18094/v1', enabled: true,
  timeoutSeconds: 600, thinking: 'off', capabilities: ['text', 'vision'],
  description: '', systemPrompt: '', temperature: 0,
}
const generation: MediaCheckpointGenerationIdentity = {
  phase: 'vision', reasoningEffort: 'off', maxTokens: 1536,
}

describe('media checkpoint model identity', () => {
  it('keeps an unversioned local alias honest while providing a stable same-task identity', () => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(identity).toEqual({
      schema: 'aiworker-media-model-identity/v1', assurance: 'request-configuration',
      routeId: route.id, model: route.model, configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      modelRevisionSha256: null,
    })
    expect(matchesMediaCheckpointModelIdentity(JSON.parse(JSON.stringify(identity)), route, generation)).toBe(true)
  })

  it('records verified weights only when the route supplies an explicit revision', () => {
    const versioned = { ...route, modelRevisionSha256: 'a'.repeat(64) }
    const identity = createMediaCheckpointModelIdentity(versioned, generation)
    expect(identity.assurance).toBe('model-revision')
    expect(identity.modelRevisionSha256).toBe('a'.repeat(64))
    expect(matchesMediaCheckpointModelIdentity(identity, versioned, generation)).toBe(true)
    expect(matchesMediaCheckpointModelIdentity(identity, { ...versioned, modelRevisionSha256: 'b'.repeat(64) }, generation)).toBe(false)
    expect(matchesMediaCheckpointModelIdentity(identity, route, generation)).toBe(false)
  })

  it.each([
    ['route', { id: 'different-route' }],
    ['model alias', { model: 'different-model' }],
    ['endpoint', { baseUrl: 'http://127.0.0.1:18091/v1' }],
    ['temperature', { temperature: 0.3 }],
    ['credential reference', { apiKeyEnv: 'OTHER_MODEL_KEY' }],
  ])('invalidates a changed %s', (_name, mutation) => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, { ...route, ...mutation }, generation)).toBe(false)
  })

  it.each([
    ['phase', { phase: 'chapter' as const }],
    ['thinking policy', { reasoningEffort: 'medium' as const }],
    ['per-segment output budget', { maxTokens: 1024 }],
  ])('invalidates a changed %s', (_name, mutation) => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, route, { ...generation, ...mutation })).toBe(false)
  })

  it('shares the effective system prompt and invalidates an explicit change', () => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, route, generation, { systemPrompt: MEDIA_ANALYSIS_SYSTEM_PROMPT })).toBe(true)
    expect(matchesMediaCheckpointModelIdentity(identity, route, generation, { systemPrompt: 'Different controlled system message' })).toBe(false)
  })

  it('ignores presentation, availability, timeout and transport batch grouping metadata', () => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, {
      ...route, label: '新标签', description: 'new note', enabled: false, timeoutSeconds: 30,
      maxImagesPerRequest: 2, maxTokens: 4096,
    }, generation)).toBe(true)
  })

  it('normalizes endpoint slashes in the same way as the generation call', () => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, { ...route, baseUrl: `${route.baseUrl}///` }, generation)).toBe(true)
  })

  it('preserves provider-default temperature as different from explicit zero', () => {
    const identity = createMediaCheckpointModelIdentity({ ...route, temperature: undefined }, generation)
    expect(matchesMediaCheckpointModelIdentity(identity, route, generation)).toBe(false)
  })

  it('does not persist endpoints, prompts or credential values in the identity', () => {
    const identity = createMediaCheckpointModelIdentity({ ...route, apiKeyEnv: 'MODEL_KEY_REFERENCE' }, generation, {
      systemPrompt: 'CONTROLLED_SYSTEM_MESSAGE_NOT_FOR_RECEIPT',
    })
    const encoded = JSON.stringify(identity)
    expect(encoded).not.toContain(route.baseUrl)
    expect(encoded).not.toContain('MODEL_KEY_REFERENCE')
    expect(encoded).not.toContain('CONTROLLED_SYSTEM_MESSAGE_NOT_FOR_RECEIPT')
  })

  it('rejects missing, malformed, extended or falsely strengthened identity receipts', () => {
    const identity = createMediaCheckpointModelIdentity(route, generation)
    for (const value of [null, {}, { ...identity, configurationSha256: 'not-a-digest' },
      { ...identity, assurance: 'model-revision' }, { ...identity, modelRevisionSha256: 'b'.repeat(64) },
      { ...identity, extra: 'uncontrolled' }]) {
      expect(mediaCheckpointModelIdentitySchema.safeParse(value).success).toBe(false)
      expect(matchesMediaCheckpointModelIdentity(value, route, generation)).toBe(false)
    }
  })

  it('rejects invalid revision metadata rather than treating it as an unversioned model', () => {
    expect(() => createMediaCheckpointModelIdentity({ ...route, modelRevisionSha256: 'invalid' }, generation)).toThrow()
    expect(() => createMediaCheckpointModelIdentity(route, { ...generation, maxTokens: 0 })).toThrow()
  })
})
