import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const roots: string[] = []

interface AuditReference {
  taskIdHashSha256: string
  status: string
  attemptCount: number
  maxAttempts: number
}

interface AuditCandidate {
  kind: 'inbox-video' | 'task-workspace'
  name: string
  disposition: 'protected' | 'audit-only'
  reason: string
  databaseReferences: AuditReference[]
}

interface AuditPlan {
  schema: string
  mode: 'dry-run'
  deletionSupported: false
  candidates: AuditCandidate[]
  rejections: Array<{ kind: string; nameHashSha256: string; reason: string }>
  summary: {
    candidates: number
    protected: number
    auditOnly: number
    rejected: number
    recentIgnored: number
  }
  planHashSha256: string
}

interface RetentionModule {
  buildMediaRetentionPlan: (options: {
    inboxRoot: string
    workRoot: string
    databasePath: string
    olderThanHours: number
    nowMs?: number
  }) => Promise<AuditPlan>
  hashAuditPayload: (payload: Record<string, unknown>) => string
  writeMediaRetentionPlan: (planPath: string, plan: AuditPlan) => Promise<string>
}

async function loadRetentionModule(): Promise<RetentionModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/lib/aiworker-media-retention.mjs')).href
  return await import(/* @vite-ignore */ url) as RetentionModule
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-retention-test-'))
  roots.push(root)
  const inbox = join(root, 'inbox')
  const work = join(root, 'work')
  const databasePath = join(root, 'mission-control.db')
  await mkdir(inbox)
  await mkdir(work)
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE n8n_task_runs (
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      input TEXT NOT NULL
    )
  `)
  database.close()
  return { root, inbox, work, databasePath }
}

function insertRun(databasePath: string, row: {
  taskId: string
  status: string
  attemptCount: number
  maxAttempts: number
  videoKey: string
  prompt: string
}) {
  const database = new Database(databasePath)
  database.prepare(`
    INSERT INTO n8n_task_runs (task_id, status, attempt_count, max_attempts, input)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    row.taskId,
    row.status,
    row.attemptCount,
    row.maxAttempts,
    JSON.stringify({ videoKey: row.videoKey, prompt: row.prompt }),
  )
  database.close()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AI-worker media retention audit', () => {
  it('protects every database reference and reports old orphans without deleting them', async () => {
    const { inbox, work, databasePath } = await fixture()
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0)
    const old = new Date(nowMs - 25 * 60 * 60 * 1000)
    const referencedVideo = '123e4567-e89b-42d3-a456-426614174000.mp4'
    const orphanVideo = '123e4567-e89b-42d3-a456-426614174001.mov'
    const recentVideo = '123e4567-e89b-42d3-a456-426614174002.mkv'
    const taskId = 'video-command-protected'
    const workspace = (await import('node:crypto')).createHash('sha256').update(taskId).digest('hex')
    const orphanWorkspace = 'f'.repeat(64)
    const secretPrompt = 'private task body must never enter the plan'

    insertRun(databasePath, {
      taskId,
      status: 'running',
      attemptCount: 1,
      maxAttempts: 2,
      videoKey: referencedVideo,
      prompt: secretPrompt,
    })
    await writeFile(join(inbox, referencedVideo), 'referenced')
    await writeFile(join(inbox, orphanVideo), 'orphan')
    await writeFile(join(inbox, recentVideo), 'recent')
    await mkdir(join(work, workspace))
    await mkdir(join(work, orphanWorkspace))
    await utimes(join(inbox, referencedVideo), old, old)
    await utimes(join(inbox, orphanVideo), old, old)
    await utimes(join(work, workspace), old, old)
    await utimes(join(work, orphanWorkspace), old, old)

    const retention = await loadRetentionModule()
    const databaseBefore = await readFile(databasePath)
    const plan = await retention.buildMediaRetentionPlan({
      inboxRoot: inbox,
      workRoot: work,
      databasePath,
      olderThanHours: 24,
      nowMs,
    })

    expect(plan.candidates.map(candidate => `${candidate.kind}:${candidate.name}`)).toEqual([
      `inbox-video:${referencedVideo}`,
      `inbox-video:${orphanVideo}`,
      `task-workspace:${workspace}`,
      `task-workspace:${orphanWorkspace}`,
    ])
    expect(plan.candidates.filter(item => item.disposition === 'protected')).toHaveLength(2)
    expect(plan.candidates.filter(item => item.disposition === 'audit-only')).toHaveLength(2)
    expect(plan.candidates.find(item => item.name === referencedVideo)).toMatchObject({
      disposition: 'protected',
      reason: 'database-reference',
      databaseReferences: [{ status: 'running', attemptCount: 1, maxAttempts: 2 }],
    })
    expect(plan.summary).toMatchObject({ candidates: 4, protected: 2, auditOnly: 2, recentIgnored: 1 })
    expect(JSON.stringify(plan)).not.toContain(secretPrompt)
    expect(await readFile(databasePath)).toEqual(databaseBefore)
    await expect(readFile(join(inbox, orphanVideo), 'utf8')).resolves.toBe('orphan')
    await expect(lstat(join(work, orphanWorkspace))).resolves.toMatchObject({})
  })

  it('refuses symlinks, produces stable ordering, and hashes no task body', async () => {
    const { root, inbox, work, databasePath } = await fixture()
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0)
    const old = new Date(nowMs - 30 * 60 * 60 * 1000)
    const target = join(root, 'outside.mp4')
    const linkName = '123e4567-e89b-42d3-a456-426614174003.mp4'
    await writeFile(target, 'outside')
    await symlink(target, join(inbox, linkName))
    await utimes(target, old, old)
    await mkdir(join(work, 'b'.repeat(64)))
    await mkdir(join(work, 'a'.repeat(64)))
    await utimes(join(work, 'a'.repeat(64)), old, old)
    await utimes(join(work, 'b'.repeat(64)), old, old)

    const retention = await loadRetentionModule()
    const first = await retention.buildMediaRetentionPlan({ inboxRoot: inbox, workRoot: work, databasePath, olderThanHours: 24, nowMs })
    const second = await retention.buildMediaRetentionPlan({ inboxRoot: inbox, workRoot: work, databasePath, olderThanHours: 24, nowMs })

    expect(first.candidates.map(candidate => candidate.name)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(first.rejections).toEqual([{
      kind: 'inbox-video',
      nameHashSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: 'symlink-refused',
    }])
    expect(first.planHashSha256).toBe(second.planHashSha256)
    const { planHashSha256: _hash, ...payload } = first
    expect(first.planHashSha256).toBe(retention.hashAuditPayload(payload as unknown as Record<string, unknown>))
  })

  it('writes a mode-0600 dry-run plan and rejects destructive or relative CLI modes', async () => {
    const { root, inbox, work, databasePath } = await fixture()
    const planOut = join(root, 'audit-plan.json')
    const cli = resolve(process.cwd(), 'scripts/aiworker-media-retention.mjs')
    const result = await execFileAsync(process.execPath, [
      cli,
      '--dry-run',
      '--inbox-root', inbox,
      '--work-root', work,
      '--db-path', databasePath,
      '--older-than-hours', '24',
      '--plan-out', planOut,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    const summary = JSON.parse(result.stdout)
    const plan = JSON.parse(await readFile(planOut, 'utf8')) as AuditPlan
    const mode = (await lstat(planOut)).mode & 0o777
    expect(summary).toMatchObject({ ok: true, mode: 'dry-run', deletionSupported: false })
    expect(plan).toMatchObject({ schema: 'aiworker-media-retention-plan/v1', mode: 'dry-run', deletionSupported: false })
    expect(mode).toBe(0o600)

    await expect(execFileAsync(process.execPath, [cli, '--apply'], {
      cwd: process.cwd(), encoding: 'utf8',
    })).rejects.toMatchObject({ stderr: expect.stringContaining('destructive_mode_unsupported') })
    await expect(execFileAsync(process.execPath, [
      cli,
      '--dry-run',
      '--inbox-root', 'relative/inbox',
      '--work-root', work,
      '--db-path', databasePath,
      '--older-than-hours', '24',
      '--plan-out', join(root, 'relative-rejected.json'),
    ], { cwd: process.cwd(), encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('inbox_root_must_be_absolute'),
    })
  })

  it('refuses a symlinked root before reading the database', async () => {
    const { root, inbox, work, databasePath } = await fixture()
    const linkedInbox = join(root, 'linked-inbox')
    await symlink(inbox, linkedInbox)
    const retention = await loadRetentionModule()
    await expect(retention.buildMediaRetentionPlan({
      inboxRoot: linkedInbox,
      workRoot: work,
      databasePath,
      olderThanHours: 24,
    })).rejects.toThrow('inbox_root_symlink_refused')
    expect(await realpath(linkedInbox)).toBe(await realpath(inbox))
  })

  it('reads a stable WAL snapshot without changing the production database files', async () => {
    const { inbox, work, databasePath } = await fixture()
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0)
    const old = new Date(nowMs - 25 * 60 * 60 * 1000)
    const videoKey = '123e4567-e89b-42d3-a456-426614174004.mp4'
    const taskId = 'wal-protected-task'
    const database = new Database(databasePath)
    try {
      database.pragma('journal_mode = WAL')
      database.pragma('wal_checkpoint(TRUNCATE)')
      database.prepare(`
        INSERT INTO n8n_task_runs (task_id, status, attempt_count, max_attempts, input)
        VALUES (?, ?, ?, ?, ?)
      `).run(taskId, 'accepted', 0, 2, JSON.stringify({ videoKey }))
      await writeFile(join(inbox, videoKey), 'wal-referenced')
      await utimes(join(inbox, videoKey), old, old)

      const sourcePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      const before = await Promise.all(sourcePaths.map(async pathname => ({
        pathname,
        bytes: await readFile(pathname),
        details: await stat(pathname),
      })))
      const retention = await loadRetentionModule()
      const plan = await retention.buildMediaRetentionPlan({ inboxRoot: inbox, workRoot: work, databasePath, olderThanHours: 24, nowMs })
      expect(plan.candidates).toContainEqual(expect.objectContaining({
        name: videoKey,
        disposition: 'protected',
      }))
      for (const snapshot of before) {
        expect(await readFile(snapshot.pathname)).toEqual(snapshot.bytes)
        const after = await stat(snapshot.pathname)
        expect(after.ino).toBe(snapshot.details.ino)
        expect(after.size).toBe(snapshot.details.size)
        expect(after.mtimeMs).toBe(snapshot.details.mtimeMs)
        expect(after.ctimeMs).toBe(snapshot.details.ctimeMs)
      }
    } finally {
      database.close()
    }
  })

  it('fails closed on malformed task input and refuses unsafe plan locations', async () => {
    const { root, inbox, work, databasePath } = await fixture()
    const database = new Database(databasePath)
    database.prepare(`
      INSERT INTO n8n_task_runs (task_id, status, attempt_count, max_attempts, input)
      VALUES (?, ?, ?, ?, ?)
    `).run('invalid-input-task', 'accepted', 0, 2, '{')
    database.close()
    const retention = await loadRetentionModule()
    await expect(retention.buildMediaRetentionPlan({
      inboxRoot: inbox,
      workRoot: work,
      databasePath,
      olderThanHours: 24,
    })).rejects.toThrow('database_input_json_invalid')

    const cleanDatabase = new Database(databasePath)
    cleanDatabase.prepare('DELETE FROM n8n_task_runs').run()
    cleanDatabase.close()
    const plan = await retention.buildMediaRetentionPlan({ inboxRoot: inbox, workRoot: work, databasePath, olderThanHours: 24 })
    await expect(retention.writeMediaRetentionPlan(
      resolve(process.cwd(), 'media-retention-plan-forbidden.json'),
      plan,
    )).rejects.toThrow('plan_out_inside_source_tree_refused')

    const publicDirectory = join(root, 'public-plan')
    await mkdir(publicDirectory)
    await chmod(publicDirectory, 0o300)
    await expect(retention.writeMediaRetentionPlan(join(publicDirectory, 'plan.json'), plan))
      .rejects.toThrow('plan_parent_must_be_private')
    await chmod(publicDirectory, 0o755)
    await expect(retention.writeMediaRetentionPlan(join(publicDirectory, 'plan.json'), plan))
      .rejects.toThrow('plan_parent_must_be_private')
    await chmod(publicDirectory, 0o700)
    const canonicalPublicDirectory = await realpath(publicDirectory)
    await expect(retention.writeMediaRetentionPlan(join(publicDirectory, 'plan.json'), plan))
      .resolves.toBe(join(canonicalPublicDirectory, 'plan.json'))
  })
})
