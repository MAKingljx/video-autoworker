import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('OpenClaw task-flow submit script', () => {
  it('uses APFS clone ingestion and accepts bounded asynchronous waits', () => {
    const script = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs'), 'utf8')
    const mediaIngest = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs'), 'utf8')
    expect(script).toContain("from '../lib/media-ingest.mjs'")
    expect(mediaIngest).toContain('COPYFILE_FICLONE_FORCE')
    expect(mediaIngest).toContain("execFileAsync('/bin/cp', ['-c', '-n', inspected.sourcePath, stagedPath])")
    expect(mediaIngest).toContain("['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(code)")
    expect(mediaIngest).toContain('await utimes(stagedPath, ingestedAt, ingestedAt)')
    expect(mediaIngest).toContain('10 * 1024 ** 3')
    expect(script).toContain('waitSeconds > 14_400')
  })

  it('loads under Node ESM before attempting the loopback request', async () => {
    const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
    const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
      execFile(process.execPath, [
        script,
        '--base-url', 'http://127.0.0.1:9',
        '--prompt', '模块加载验证',
      ], { timeout: 5_000, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolvePromise({
          failed: Boolean(error),
          stdout,
          stderr,
        })
      })
    })
    expect(result.failed).toBe(true)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('SyntaxError')
    expect(result.stderr).not.toContain('does not provide an export named')
  })

  it('classifies loopback service outages as retryable batch pauses', async () => {
    const moduleUrl = pathToFileURL(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/lib/platform-client.mjs',
    )).href
    const platform = await import(/* @vite-ignore */ moduleUrl) as {
      createPlatformClient: (url: string) => { getRun: (taskId: string) => Promise<unknown> }
      isRetryablePlatformError: (error: unknown) => boolean
    }
    const client = platform.createPlatformClient('http://127.0.0.1:9')
    const error = await client.getRun('unreachable-test').catch(caught => caught)
    expect(platform.isRetryablePlatformError(error)).toBe(true)
  })

  it('requires one explicit stable identity for durable task submissions', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')

    expect(skill).toContain('both `--task-id` and `--idempotency-key`')
    expect(skill.match(/--task-id <stable-key>/g)).toHaveLength(3)
    expect(skill).toContain('never tell the user to pass a batch ID to')
    expect(skill).toContain('`--batch-status <stable-batch-key>`')
  })

  it('defines the one-line video command as an asynchronous stateless skill entry', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    expect(skill).toContain('分析视频 /完整路径/video.mp4')
    expect(skill).toContain('`分析视频 <绝对路径>`')
    expect(skill).toContain('--video-file "<absolute-video-path>"')
    expect(skill).toContain('--task-id <stable-request-key>')
    expect(skill).toContain('--idempotency-key <stable-request-key>')
    expect(skill).toContain('--delivery none')
    expect(skill).toContain('--wait-seconds 0')
    expect(skill).toContain('overrides the execution phrase and means no task submission')
    expect(workspaceRules).toContain('`分析视频 <绝对路径>`')
    expect(workspaceRules).toContain('user does not need to name the skill')
  })

  it('contracts the exact one-line command to one silent submission and one receipt', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules]) {
      expect(contract).toContain('one and only one n8n submission')
      expect(contract).toMatch(/马上开始.*我先找.*让我检查/s)
      expect(contract).toMatch(/direct `ffmpeg`, Whisper,\s+Qwen, VL/)
      expect(contract).toMatch(/Do not run\s+`ls`, `find`, `stat`/)
      expect(contract).toMatch(/do not\s+poll/i)
      expect(contract).toContain('same turn')
      expect(contract).toMatch(/one\s+short acknowledgement/)
      expect(contract).toMatch(/one\s+short error/)
      expect(contract).toContain('new explicit status or')
      expect(contract).toContain('monitoring request')
    }
    expect(skill).toContain('exactly once in the current turn')
    expect(skill).toMatch(/containing only `taskId`,\s+`status`, and `duplicate`/)
    expect(skill).toContain('已提交：taskId=<taskId>，status=<status>，duplicate=<true|false>。')
    expect(skill).toContain('提交失败：<简短错误>。')
    expect(workspaceRules).toContain('`delivery=none` and')
    expect(workspaceRules).toContain('`wait-seconds=0`')
    expect(workspaceRules).toContain('`memoryMode=none`')
  })

  it('installs the componentized client, media, batch state, and worker modules', () => {
    const installer = readFileSync(resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh'), 'utf8')
    expect(installer).toContain('run-video-batch.mjs')
    expect(installer).toContain('video-batch-state.mjs')
    expect(installer).toContain('"$SOURCE_DIR"/lib/*.mjs')
    expect(installer).toContain('"$SOURCE_DIR"/scripts/*.mjs')
  })

  it('appends the video command rule to a workspace that has no previous section', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-task-flow-install-test-'))
    const workspace = resolve(root, 'workspace')
    const installer = resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh')
    const runInstaller = (backupRoot: string) => new Promise<void>((resolvePromise, rejectPromise) => {
      execFile('bash', [installer], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AIWORKER_QWEN_WORKSPACE: workspace,
          AIWORKER_SKILL_BACKUP_ROOT: backupRoot,
        },
        encoding: 'utf8',
      }, error => error ? rejectPromise(error) : resolvePromise())
    })

    try {
      await mkdir(workspace, { recursive: true })
      await writeFile(resolve(workspace, 'AGENTS.md'), '# Workspace Rules\n\nKeep this rule.\n')
      await runInstaller(resolve(root, 'backups-1'))
      await runInstaller(resolve(root, 'backups-2'))

      const agents = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('Keep this rule.')
      expect(agents).toContain('`分析视频 <绝对路径>`')
      expect(agents.match(/^## Video Analysis Task Flow Rule$/gm)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts absolute video paths containing Chinese, spaces, parentheses, and quotes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-path-test-'))
    try {
      const video = resolve(root, "地球之极 第一集 (成片)'v1'.mp4")
      await writeFile(video, 'video')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs',
      )).href
      const media = await import(/* @vite-ignore */ moduleUrl) as {
        inspectVideoFile: (path: string) => Promise<{ sourcePath: string; sourceBytes: number }>
      }
      const inspected = await media.inspectVideoFile(video)
      expect(inspected.sourcePath).toBe(await realpath(video))
      expect(inspected.sourceBytes).toBe(5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers a deterministic sorted video batch and derives stable task ids', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-batch-test-'))
    try {
      await writeFile(resolve(root, '02-blue.mp4'), 'blue')
      await writeFile(resolve(root, '01-red.mov'), 'red')
      await writeFile(resolve(root, 'notes.txt'), 'ignore')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        discoverBatchVideos: (path: string) => Promise<{ videos: Array<{ name: string; path: string }> }>
        deriveBatchTaskId: (batchId: string, index: number, path: string) => string
      }
      const discovered = await batch.discoverBatchVideos(root)
      expect(discovered.videos.map(video => video.name)).toEqual(['01-red.mov', '02-blue.mp4'])
      const first = batch.deriveBatchTaskId('batch-test-1', 1, discovered.videos[0].path)
      expect(batch.deriveBatchTaskId('batch-test-1', 1, discovered.videos[0].path)).toBe(first)
      expect(first).toMatch(/^batch-test-1:video:001:/)
      expect(first.length).toBeLessThanOrEqual(120)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists one immutable batch identity without exposing source paths in status', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-batch-state-test-'))
    try {
      await writeFile(resolve(root, '01-red.mp4'), 'red')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{
          duplicate: boolean
          state: Record<string, unknown> & { prompt: string }
        }>
        summarizeBatchState: (state: Record<string, unknown>) => {
          items: Array<Record<string, unknown>>
        }
      }
      const input = {
        batchId: 'batch-state-test-1',
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 1,
        prompt: 'first prompt',
        visionRoute: null,
        videoDir: root,
        inboxRoot: resolve(root, 'inbox'),
        batchRoot: resolve(root, 'state'),
      }
      const created = await batch.createBatchState(input)
      const duplicate = await batch.createBatchState({ ...input, prompt: 'changed prompt' })
      expect(created.duplicate).toBe(false)
      expect(duplicate.duplicate).toBe(true)
      expect(duplicate.state.prompt).toBe('first prompt')
      expect(batch.summarizeBatchState(created.state).items[0]).not.toHaveProperty('sourcePath')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
