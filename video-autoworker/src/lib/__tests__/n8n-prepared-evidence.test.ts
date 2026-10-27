// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaTaskWorkspace } from '@/lib/n8n-media-workspace'
import type { N8nModelRoute } from '@/lib/n8n-model-routing'
import { createMediaCheckpointModelIdentity } from '@/lib/n8n-media-checkpoint-identity'
import { inspectPreparedRecoveryEvidence, writePreparedMediaProof } from '@/lib/n8n-prepared-evidence'

const models = vi.hoisted(() => ({ registry: vi.fn(), resolved: vi.fn() }))
vi.mock('@/lib/n8n-model-routing', async original => ({
  ...await original<typeof import('@/lib/n8n-model-routing')>(),
  loadN8nModelRegistry: models.registry, resolveN8nNodeRoute: models.resolved,
  publicN8nModelRoute: () => ({ available: true }),
  publicAuxiliaryModelResource: async () => ({ available: true }),
}))

const taskId = 'prepared-checkpoint-scope'
const routing = { config: { media: { segmentSeconds: 5 } } }
const input = { videoKey: 'already-consumed.mp4' }
const sourceSha256 = 'a'.repeat(64)
const route: Extract<N8nModelRoute, { transport: 'openai-compatible' }> = {
  id: 'vision', resourceId: 'vision-resource', label: 'Vision', transport: 'openai-compatible',
  location: 'local', model: 'vision-model', baseUrl: 'http://127.0.0.1:18094/v1', enabled: true,
  capabilities: ['vision'], timeoutSeconds: 120, thinking: 'off', description: '', systemPrompt: '',
}
let root: string
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'n8n-prepared-evidence-'))
  vi.stubEnv('AIWORKER_MEDIA_WORK_DIR', root)
  workspace = mediaTaskWorkspace(taskId)
  await mkdir(join(workspace, 'segment-001'), { recursive: true, mode: 0o700 })
  await mkdir(join(workspace, 'checkpoints'), { mode: 0o700 })
  await writeFile(join(workspace, 'segment-001', 'scene-01.jpg'), 'unchanged-source-frame', { mode: 0o600 })
  const metadata = { taskId, kind: 'prepared-video', sourceSha256, sourceBytes: 32, segmentSeconds: 5,
    segmentCount: 1, audioAvailable: false, audioSourceFile: null,
    segments: [{ index: 1, frameFiles: ['segment-001/scene-01.jpg'], audioFile: null }] }
  await writeFile(join(workspace, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 })
  await writePreparedMediaProof(taskId, routing, input, metadata)
  models.registry.mockReturnValue({ routes: [route], resources: [
    { id: 'vision-resource', enabled: true, runtime: { type: 'openai-compatible' } },
  ], errors: [] })
  models.resolved.mockReturnValue({ route })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

async function inspectWithProof(proof: unknown) {
  await writeFile(join(workspace, 'checkpoints', 'vision-001.json'), JSON.stringify({ index: 1, proof }), { mode: 0o600 })
  return inspectPreparedRecoveryEvidence(taskId, routing, input, ['audio'])
}

function currentProof() {
  return { schema: 'aiworker-vision-checkpoint-v3', taskId, sourceSha256, segmentSeconds: 5,
    routeId: route.id, model: route.model,
    modelIdentity: createMediaCheckpointModelIdentity(route, { phase: 'vision', reasoningEffort: 'off', maxTokens: 1536 }) }
}

describe('prepared recovery accepts the current checkpoint identity envelope', () => {
  it('permits a configuration-level v3 envelope without inventing a weight revision', async () => {
    expect(await inspectWithProof(currentProof())).toMatchObject({ eligible: true, totalSegments: 1 })
  })

  it('continues to permit an explicit-revision v2 envelope as read-only historical evidence', async () => {
    expect(await inspectWithProof({ schema: 'aiworker-vision-checkpoint-v2', sourceSha256,
      segmentSeconds: 5, modelRevisionSha256: 'b'.repeat(64) })).toMatchObject({ eligible: true })
  })

  it.each([
    ['different task', { taskId: 'other-task' }],
    ['different source', { sourceSha256: 'f'.repeat(64) }],
    ['different window', { segmentSeconds: 60 }],
    ['different model', { model: 'other-model' }],
    ['different route', { routeId: 'other-route' }],
    ['missing model identity', { modelIdentity: undefined }],
  ])('refuses a v3 envelope with %s', async (_label, mutation) => {
    expect(await inspectWithProof({ ...currentProof(), ...mutation })).toMatchObject({
      eligible: false, errorCode: 'recovery_checkpoint_identity_missing',
    })
  })

  it('never upgrades missing legacy proof or a false model revision', async () => {
    for (const value of [undefined, null, {},
      { schema: 'aiworker-vision-checkpoint-v2', sourceSha256, segmentSeconds: 5 },
      { schema: 'aiworker-vision-checkpoint-v2', sourceSha256, segmentSeconds: 5, modelRevisionSha256: 'invalid' },
      { ...currentProof(), modelIdentity: { ...currentProof().modelIdentity, assurance: 'model-revision' } }]) {
      expect(await inspectWithProof(value)).toMatchObject({ eligible: false, errorCode: 'recovery_checkpoint_identity_missing' })
    }
  })
})
