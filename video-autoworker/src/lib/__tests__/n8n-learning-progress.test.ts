// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nTaskRun } from '@/lib/n8n-task-runs'
import { mediaChildIdentity, mediaTaskWorkspace } from '@/lib/n8n-media-workspace'
import { createLearningProgressReporter, estimateLearningStageRemaining, getScopedLearningProgress, readControlledMediaJson } from '@/lib/n8n-learning-progress'
import { writePreparedMediaProof, inspectPreparedRecoveryEvidence } from '@/lib/n8n-prepared-evidence'

const modelMocks = vi.hoisted(() => ({ registry: vi.fn(), resolved: vi.fn() }))
vi.mock('@/lib/n8n-model-routing', async original => ({
  ...await original<typeof import('@/lib/n8n-model-routing')>(), loadN8nModelRegistry: modelMocks.registry,
  resolveN8nNodeRoute: modelMocks.resolved, publicN8nModelRoute: () => ({ available: true }),
  publicAuxiliaryModelResource: async () => ({ available: true }),
}))

const scope = { tenantId: 3, workspaceId: 2 }
const taskId = 'progress-video'
let db: Database.Database
let root: string
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'n8n-learning-progress-'))
  vi.stubEnv('AIWORKER_MEDIA_WORK_DIR', root)
  workspace = mediaTaskWorkspace(taskId)
  await mkdir(workspace, { mode: 0o700 })
  db = new Database(':memory:')
  runMigrations(db)
  createN8nTaskRun(db, { taskId, idempotencyKey: taskId, bindingId: 9, source: 'openclaw', requestedBy: 'test',
    routing: { taskType: 'video-analysis' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  createN8nTaskRun(db, { taskId: mediaChildIdentity('task', taskId, 'vision'),
    idempotencyKey: mediaChildIdentity('idem', taskId, 'vision'), bindingId: 9, source: 'n8n-media-node', requestedBy: 'test',
    routing: { mediaStage: 'vision' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  db.prepare(`UPDATE n8n_task_runs SET status='running'`).run()
  const command = join(root, 'audio-runner')
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const vision = { id: 'vision', resourceId: 'vision-resource', enabled: true, transport: 'openai-compatible',
    model: 'test-model', modelRevisionSha256: 'b'.repeat(64) }
  modelMocks.registry.mockReturnValue({ routes: [vision], resources: [
    { id: 'whisper-large-v3-turbo', enabled: true, runtime: { type: 'cli', command } },
    { id: 'vision-resource', enabled: true, runtime: { type: 'openai-compatible' } },
  ], errors: [], source: 'test' })
  modelMocks.resolved.mockReturnValue({ route: vision })
})

afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('rebuildable learning projection', () => {
  it('records actual phase counts/models/cache and estimates only with adequate observed samples', async () => {
    const report = createLearningProgressReporter(taskId, 'vision', 10, 'Model A')
    await report(1, 0, { elapsedSeconds: 4, units: 1, model: 'Model A' })
    await report(2, 0, { elapsedSeconds: 6, units: 1, model: 'Model A' })
    expect((await getScopedLearningProgress(db, taskId, scope))?.stages[2].remainingSeconds).toBeNull()
    await report(4, 1, { elapsedSeconds: 10, units: 2, model: 'Model A' })
    const projection = await getScopedLearningProgress(db, taskId, scope)
    expect(projection?.stages[2]).toMatchObject({ completedSegments: 4, totalSegments: 10, cacheHits: 1,
      model: 'Model A', remainingSeconds: { lower: 24, upper: 54, samples: 3, basis: 'current-stage' } })
    expect(JSON.stringify(projection)).not.toMatch(/percent|transcript|prompt/u)
    await report(5, 1, { elapsedSeconds: 2, units: 1, model: 'Model B' })
    expect((await getScopedLearningProgress(db, taskId, scope))?.stages[2].remainingSeconds).toBeNull()
  })

  it('keeps database terminal state authoritative over stale running progress', async () => {
    await createLearningProgressReporter(taskId, 'vision', 10, 'Model A')(4, 1)
    db.prepare(`UPDATE n8n_task_runs SET status='failed'`).run()
    const projection = await getScopedLearningProgress(db, taskId, scope)
    expect(projection?.state).toBe('failed')
    expect(projection?.activeStages).toEqual([])
    expect(projection?.stages[2].remainingSeconds).toBeNull()
  })

  it('refuses another tenant and rejects traversal/symlink display files', async () => {
    expect(await getScopedLearningProgress(db, taskId, { ...scope, tenantId: 7 })).toBeNull()
    const target = join(root, 'private.json')
    await writeFile(target, '{"private":true}', { mode: 0o600 })
    expect(await readControlledMediaJson(workspace, '../private.json')).toBeNull()
    await symlink(target, join(workspace, 'linked.json'))
    expect(await readControlledMediaJson(workspace, 'linked.json')).toBeNull()
  })

  it('rebuilds completed phase counts from scoped database output if the projection is absent', async () => {
    db.prepare(`UPDATE n8n_task_runs SET status='succeeded',output=? WHERE task_id=?`)
      .run(JSON.stringify({ segmentCount: 10, model: 'Model C' }), mediaChildIdentity('task', taskId, 'vision'))
    expect((await getScopedLearningProgress(db, taskId, scope))?.stages[2]).toMatchObject({
      state: 'succeeded', totalSegments: 10, completedSegments: 10, model: 'Model C', cacheHits: null,
    })
    expect(estimateLearningStageRemaining(0, 100, [1, 2, 3])).toBeNull()
  })
})

describe('prepared evidence for consumed-source recovery', () => {
  async function prepared() {
    await mkdir(join(workspace, 'segment-001'), { mode: 0o700 })
    await writeFile(join(workspace, 'segment-001', 'scene-01.jpg'), 'original frame')
    const metadata = { taskId, kind: 'prepared-video', sourceSha256: 'a'.repeat(64), sourceBytes: 20,
      segmentCount: 1, segmentSeconds: 5, audioAvailable: false, audioSourceFile: null,
      segments: [{ index: 1, frameFiles: ['segment-001/scene-01.jpg'], audioFile: null }] }
    await writeFile(join(workspace, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 })
    const routing = { config: { media: { segmentSeconds: 5 } } }
    const input = { videoKey: 'already-consumed.mp4' }
    await writePreparedMediaProof(taskId, routing, input, metadata)
    return { routing, input }
  }

  it('accepts verified prepared assets without requiring a consumed original video file', async () => {
    const { routing, input } = await prepared()
    expect(await inspectPreparedRecoveryEvidence(taskId, routing, input)).toMatchObject({ eligible: true, totalSegments: 1 })
  })

  it('rejects missing legacy proof, changed inputs, modified assets and unproven vision checkpoints', async () => {
    const { routing, input } = await prepared()
    expect(await inspectPreparedRecoveryEvidence(taskId, routing, { videoKey: 'changed.mp4' })).toMatchObject({ eligible: false })
    await mkdir(join(workspace, 'checkpoints'), { mode: 0o700 })
    await writeFile(join(workspace, 'checkpoints', 'vision-001.json'), '{"index":1}', { mode: 0o600 })
    expect(await inspectPreparedRecoveryEvidence(taskId, routing, input)).toMatchObject({
      eligible: false, errorCode: 'recovery_checkpoint_identity_missing' })
    await writeFile(join(workspace, 'segment-001', 'scene-01.jpg'), 'modified frame')
    expect(await inspectPreparedRecoveryEvidence(taskId, routing, input)).toMatchObject({
      eligible: false, errorCode: 'recovery_prepared_assets_changed' })
    const proof = await readFile(join(workspace, 'prepared-proof.json'))
    expect(proof.length).toBeLessThan(2048)
    await rm(join(workspace, 'prepared-proof.json'))
    expect(await inspectPreparedRecoveryEvidence(taskId, routing, input)).toMatchObject({
      eligible: false, errorCode: 'recovery_prepared_evidence_unverified' })
  })
})
