import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { parseN8nMediaConfig } from '@/lib/n8n-media-config'
import { readControlledMediaJson } from '@/lib/n8n-learning-progress'
import { mediaTaskWorkspace } from '@/lib/n8n-media-workspace'
import { loadN8nModelRegistry, resolveN8nNodeRoute, publicAuxiliaryModelResource, publicN8nModelRoute } from '@/lib/n8n-model-routing'

const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const metadataSchema = z.object({
  taskId: z.string().max(120), kind: z.literal('prepared-video'), sourceSha256: sha,
  sourceBytes: z.number().int().positive(), segmentSeconds: z.number().int().min(1).max(300),
  segmentCount: z.number().int().min(1).max(100_000),
  audioAvailable: z.boolean(), audioSourceFile: z.string().nullable().optional(),
  segments: z.array(z.object({ index: z.number().int().positive(),
    frameFiles: z.array(z.string()).min(1).max(6), audioFile: z.string().nullable().optional(),
  }).passthrough()).max(100_000),
}).passthrough()
const proofSchema = z.object({ schema: z.literal('aiworker-prepared-media-proof/v1'), taskId: z.string().max(120),
  metadataSha256: sha, inputSha256: sha, assetsSha256: sha, sourceSha256: sha,
}).strict()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const routingConfig = (routing: Record<string, unknown>) => routing.config && typeof routing.config === 'object'
  && !Array.isArray(routing.config) ? routing.config as Record<string, unknown> : {}

function inputDigest(taskId: string, routing: Record<string, unknown>, input: Record<string, unknown>) {
  return digest({ taskId, videoKey: input.videoKey, materialId: input.materialId ?? null,
    media: parseN8nMediaConfig(routingConfig(routing)) })
}

async function assetManifest(workspace: string, metadata: z.infer<typeof metadataSchema>) {
  const paths = metadata.segments.flatMap(segment => segment.frameFiles)
  if (metadata.audioAvailable) {
    if (metadata.audioSourceFile !== 'audio.wav') throw new Error('recovery_prepared_audio_missing')
    paths.push(metadata.audioSourceFile)
  }
  const physical = await realpath(workspace)
  const manifest: unknown[] = []
  for (let offset = 0; offset < paths.length; offset += 8) {
    manifest.push(...await Promise.all(paths.slice(offset, offset + 8).map(async name => {
      if (name !== 'audio.wav' && !/^segment-\d{3,6}\/(?:scene|uniform)-\d{2}\.jpg$/u.test(name)) {
        throw new Error('recovery_prepared_asset_invalid')
      }
      const path = join(workspace, name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0
        || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== join(physical, name)) {
        throw new Error('recovery_prepared_asset_invalid')
      }
      return { name, dev: stat.dev, ino: stat.ino, bytes: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }
    })))
  }
  return digest(manifest)
}

export async function writePreparedMediaProof(taskId: string, routing: Record<string, unknown>, input: Record<string, unknown>, metadataValue: Record<string, unknown>) {
  const metadata = metadataSchema.parse(metadataValue)
  if (metadata.taskId !== taskId || metadata.segmentCount !== metadata.segments.length) throw new Error('prepared_media_identity_invalid')
  const workspace = mediaTaskWorkspace(taskId)
  const proof = proofSchema.parse({ schema: 'aiworker-prepared-media-proof/v1', taskId,
    metadataSha256: digest(metadataValue), inputSha256: inputDigest(taskId, routing, input),
    assetsSha256: await assetManifest(workspace, metadata), sourceSha256: metadata.sourceSha256,
  })
  const temporary = join(workspace, `.prepared-proof-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await handle.writeFile(JSON.stringify(proof)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(workspace, 'prepared-proof.json'))
  } finally { await unlink(temporary).catch(() => {}) }
}

export interface PreparedRecoveryEvidence {
  eligible: boolean
  errorCode: string | null
  nextAction: string
  revisionSha256: string | null
  totalSegments: number | null
  missingResources: string[]
}

export async function inspectPreparedRecoveryEvidence(taskId: string, routing: Record<string, unknown>, input: Record<string, unknown>, successfulStages: string[] = []): Promise<PreparedRecoveryEvidence> {
  const blocked = (errorCode: string, missingResources: string[] = []): PreparedRecoveryEvidence => ({
    eligible: false, errorCode, nextAction: 'inspect_resources_or_evidence', revisionSha256: null,
    totalSegments: null, missingResources,
  })
  const workspace = mediaTaskWorkspace(taskId)
  const raw = await readControlledMediaJson(workspace, 'metadata.json', 8 * 1024 * 1024)
  const metadata = metadataSchema.safeParse(raw)
  const proof = proofSchema.safeParse(await readControlledMediaJson(workspace, 'prepared-proof.json'))
  if (!metadata.success || !proof.success) return blocked('recovery_prepared_evidence_unverified', ['已校验的准备结果'])
  const value = metadata.data
  if (value.taskId !== taskId || proof.data.taskId !== taskId || value.segmentCount !== value.segments.length
    || proof.data.metadataSha256 !== digest(raw) || proof.data.inputSha256 !== inputDigest(taskId, routing, input)
    || proof.data.sourceSha256 !== value.sourceSha256) return blocked('recovery_prepared_evidence_changed')
  try {
    if (await assetManifest(workspace, value) !== proof.data.assetsSha256) return blocked('recovery_prepared_assets_changed')
  } catch { return blocked('recovery_prepared_assets_missing', ['已准备的音轨或画面']) }
  const registry = loadN8nModelRegistry()
  const missing: string[] = []
  if (registry.errors.length) missing.push('模型配置')
  if (!successfulStages.includes('audio')) {
    const resourceId = parseN8nMediaConfig(routingConfig(routing)).audioResourceId
    const resource = registry.resources.find(candidate => candidate.id === resourceId && candidate.enabled)
    if (!resource || resource.runtime.type !== 'cli') missing.push('语音模型')
    else try { await access(resource.runtime.command.replace(/^~(?=\/)/u, homedir()), constants.X_OK) } catch { missing.push('语音模型') }
  }
  try {
    const resolved = resolveN8nNodeRoute(routing, 'vision')
    if (!publicN8nModelRoute(resolved.route).available || resolved.route.transport !== 'openai-compatible') missing.push('画面模型')
    const resource = registry.resources.find(candidate => candidate.id === (resolved.route.resourceId || resolved.route.id))
    if (!resource || !(await publicAuxiliaryModelResource(resource)).available) missing.push('画面模型服务')
  } catch { missing.push('画面模型') }
  if (missing.length) return blocked('recovery_resources_missing', [...new Set(missing)])
  // Partial historical files must carry the current identity envelope. They
  // are never promoted to trusted caches just because a filename exists.
  try {
    const names = await readdir(join(workspace, 'checkpoints'))
    for (const name of names) {
      if (!/^vision-\d{3,6}\.json$/u.test(name)) continue
      const checkpoint = await readControlledMediaJson(workspace, `checkpoints/${name}`, 256 * 1024)
      const identity = checkpoint?.proof as Record<string, unknown> | undefined
      if (!identity || identity.schema !== 'aiworker-vision-checkpoint-v2'
        || identity.sourceSha256 !== value.sourceSha256 || identity.segmentSeconds !== value.segmentSeconds
        || typeof identity.modelRevisionSha256 !== 'string') return blocked('recovery_checkpoint_identity_missing')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return blocked('recovery_checkpoint_unreadable')
  }
  return { eligible: true, errorCode: null, nextAction: 'confirm_same_task_recovery',
    revisionSha256: digest({ proof: proof.data, modelRegistry: registry }), totalSegments: value.segmentCount, missingResources: [] }
}
