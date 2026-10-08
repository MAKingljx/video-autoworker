import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { config } from '@/lib/config'

export function mediaInboxRoot(): string {
  return resolve(String(process.env.AIWORKER_MEDIA_INGEST_DIR || '').trim()
    || join(homedir(), 'ai-worker/state/video-autoworker/media-inbox'))
}

export function mediaWorkRoot(): string {
  return resolve(String(process.env.AIWORKER_MEDIA_WORK_DIR || '').trim() || join(config.dataDir, 'media-tasks'))
}

export function mediaTaskWorkspace(taskId: string): string {
  return join(mediaWorkRoot(), createHash('sha256').update(taskId).digest('hex'))
}

export function mediaChildIdentity(prefix: 'task' | 'idem', taskId: string, stage: string): string {
  const digest = createHash('sha256').update(`${taskId}:${stage}`).digest('hex').slice(0, 24)
  return `media-${prefix}:${taskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}
