import type Database from 'better-sqlite3'
import { constants } from 'node:fs'
import { lstat, open, realpath, mkdir, rename, unlink, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { z } from 'zod'
import { getScopedN8nTaskRunByTaskId, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { mediaChildIdentity, mediaTaskWorkspace, mediaWorkRoot } from '@/lib/n8n-media-workspace'

export const LEARNING_STAGES = ['prepare', 'audio', 'vision', 'finalize'] as const
export type LearningStage = typeof LEARNING_STAGES[number]
const MAX_SEGMENTS = 100_000
const MAX_JSON_BYTES = 128 * 1024
const stageSchema = z.enum(LEARNING_STAGES)
const phaseProgressSchema = z.object({
  schema: z.literal('aiworker-learning-phase-progress/v1'), taskId: z.string().min(1).max(120),
  stage: stageSchema, totalSegments: z.number().int().min(1).max(MAX_SEGMENTS),
  completedSegments: z.number().int().min(0).max(MAX_SEGMENTS),
  model: z.string().min(1).max(180).nullable(), cacheHits: z.number().int().min(0).max(MAX_SEGMENTS),
  samples: z.array(z.number().positive().max(86_400)).max(16), updatedAt: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.completedSegments > value.totalSegments || value.cacheHits > value.completedSegments) {
    ctx.addIssue({ code: 'custom', message: 'invalid_progress_count' })
  }
})

export interface LearningStageProgress {
  stage: LearningStage
  state: string
  totalSegments: number | null
  completedSegments: number | null
  model: string | null
  cacheHits: number | null
  remainingSeconds: { lower: number; upper: number; samples: number; basis: 'current-stage' } | null
}

export interface LearningProgressProjection {
  schema: 'aiworker-learning-progress/v1'
  taskId: string
  state: string
  stages: LearningStageProgress[]
  activeStages: LearningStage[]
  generatedAt: number
}

export async function readControlledMediaJson(workspace: string, relativePath: string, maximumBytes = MAX_JSON_BYTES): Promise<Record<string, unknown> | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    if (isAbsolute(relativePath) || normalize(relativePath) !== relativePath
      || relativePath.split('/').some(part => !part || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f]/u.test(relativePath)) return null
    const root = await realpath(mediaWorkRoot())
    const workspaceStat = await lstat(workspace)
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) return null
    const physical = await realpath(workspace)
    if (dirname(physical) !== root) return null
    const path = join(workspace, relativePath)
    if (await realpath(path) !== join(physical, relativePath)) return null
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 2 || entry.size > maximumBytes
      || (entry.mode & 0o077) || (process.getuid && entry.uid !== process.getuid())) return null
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) return null
    const raw = await handle.readFile('utf8')
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null } finally { await handle?.close() }
}

export function estimateLearningStageRemaining(completed: number, total: number, samples: number[]) {
  const valid = samples.filter(value => Number.isFinite(value) && value > 0).slice(-16)
  if (valid.length < 3 || completed < 1 || total <= completed) return null
  const remaining = total - completed
  return { lower: Math.floor(Math.min(...valid) * remaining),
    upper: Math.ceil(Math.max(...valid) * remaining * 1.5), samples: valid.length, basis: 'current-stage' as const }
}

export function createLearningProgressReporter(taskId: string, stage: LearningStage, totalSegments: number, initialModel: string | null) {
  const workspace = mediaTaskWorkspace(taskId)
  let model = initialModel
  let samples: number[] = []
  return async (completedSegments: number, cacheHits: number, sample?: { elapsedSeconds: number; units: number; model: string }) => {
    if (sample?.model !== undefined && sample.model !== model) { model = sample.model; samples = [] }
    if (sample && sample.elapsedSeconds > 0 && sample.units > 0) {
      samples = [...samples, sample.elapsedSeconds / sample.units].slice(-16)
    }
    const parsed = phaseProgressSchema.safeParse({ schema: 'aiworker-learning-phase-progress/v1', taskId, stage,
      totalSegments, completedSegments, model, cacheHits, samples, updatedAt: Date.now() })
    if (!parsed.success) return
    const directory = join(workspace, 'progress')
    const temporary = join(directory, `.${stage}-${randomUUID()}.tmp`)
    try {
      const root = await realpath(mediaWorkRoot())
      const location = await lstat(workspace)
      if (location.isSymbolicLink() || !location.isDirectory() || dirname(await realpath(workspace)) !== root) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink()) return
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try { await file.writeFile(JSON.stringify(parsed.data)); await file.sync() } finally { await file.close() }
      await rename(temporary, join(directory, `${stage}.json`))
      await chmod(join(directory, `${stage}.json`), 0o600)
    } catch {
      // A rebuildable display projection must never change execution outcome.
    } finally { await unlink(temporary).catch(() => {}) }
  }
}

interface ChildSummary { status: string; segment_count: number | null; model: string | null }

export async function getScopedLearningProgress(db: Database.Database, taskId: string, scope: N8nTaskScope): Promise<LearningProgressProjection | null> {
  // This lookup must precede every filesystem read, including unknown tasks.
  const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
  if (!run || run.routing?.taskType !== 'video-analysis' || !['video-autoworker', 'openclaw'].includes(run.source)) return null
  const workspace = mediaTaskWorkspace(run.taskId)
  const stages = await Promise.all(LEARNING_STAGES.map(async stage => {
    const child = db.prepare(`SELECT status,
      CASE WHEN json_valid(output) THEN COALESCE(json_extract(output, '$.segmentCount'),
        json_array_length(json_extract(output, '$.segmentSummaries'))) END AS segment_count,
      CASE WHEN json_valid(output) THEN json_extract(output, '$.model') END AS model
      FROM n8n_task_runs WHERE task_id=? AND tenant_id=? AND workspace_id=? AND binding_id=? AND source='n8n-media-node'
    `).get(mediaChildIdentity('task', taskId, stage), scope.tenantId, scope.workspaceId, run.bindingId) as ChildSummary | undefined
    const raw = await readControlledMediaJson(workspace, `progress/${stage}.json`)
    const parsed = phaseProgressSchema.safeParse(raw)
    const value = parsed.success && parsed.data.taskId === taskId && parsed.data.stage === stage ? parsed.data : null
    const total = value?.totalSegments ?? (Number.isSafeInteger(child?.segment_count) && Number(child?.segment_count) > 0 ? child!.segment_count : null)
    const state = child?.status || (run.status === 'succeeded' ? 'succeeded' : 'unknown')
    const completed = state === 'succeeded' ? total : value?.completedSegments ?? null
    return { stage, state, totalSegments: total, completedSegments: completed,
      model: value?.model || (typeof child?.model === 'string' && child.model.length <= 180 ? child.model : null),
      cacheHits: value?.cacheHits ?? null,
      remainingSeconds: state === 'running' && run.status === 'running' && value
        ? estimateLearningStageRemaining(value.completedSegments, value.totalSegments, value.samples) : null,
    } satisfies LearningStageProgress
  }))
  return { schema: 'aiworker-learning-progress/v1', taskId, state: run.status, stages,
    activeStages: run.status === 'running' ? stages.filter(stage => stage.state === 'running').map(stage => stage.stage) : [],
    generatedAt: Date.now() }
}
