import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('OpenClaw task-flow submit script', () => {
  it('parses only the exact single-line video command', async () => {
    const moduleUrl = pathToFileURL(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/lib/video-command.mjs',
    )).href
    const command = await import(/* @vite-ignore */ moduleUrl) as {
      parseExactVideoCommand: (value: unknown) => string | null
      deriveVideoCommandTaskKey: (videoFile: string) => string
    }

    const accepted = [
      ['分析视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
      ['分析视频 /Users/Shared/中文目录/样片(终版).MOV', '/Users/Shared/中文目录/样片(终版).MOV'],
      ['分析视频 /Users/Shared/中文 目录/样片 (终版).MOV', '/Users/Shared/中文 目录/样片 (终版).MOV'],
      ['分析视频 "/Users/Shared/中文 目录/样片 (终版).mkv"', '/Users/Shared/中文 目录/样片 (终版).mkv'],
      ["分析视频 '/Users/Shared/person\"s clip (v2).webm'", '/Users/Shared/person"s clip (v2).webm'],
      ["分析视频 /Users/Shared/person's.mp4", "/Users/Shared/person's.mp4"],
      ['分析视频 /Users/Shared/person"s.mp4', '/Users/Shared/person"s.mp4'],
      ['分析视频 /tmp/demo.mp4 补充.mp4', '/tmp/demo.mp4 补充.mp4'],
    ]
    for (const [input, expected] of accepted) {
      expect(command.parseExactVideoCommand(input), input).toBe(expected)
    }

    const rejected: unknown[] = [
      undefined,
      null,
      '',
      '分析视频 ',
      '分析视频  /tmp/demo.mp4',
      '分析视频 ./demo.mp4',
      '分析视频 ~/demo.mp4',
      '分析视频 /tmp/demo.mp4\n',
      '分析视频 /tmp/demo.mp4\r\n马上开始',
      '马上开始 分析视频 /tmp/demo.mp4',
      '分析视频 "/tmp/demo.mp4',
      "分析视频 '/tmp/demo.mp4\"",
      '分析视频 "/tmp/demo.mp4" 现在开始',
      '分析视频 /tmp/demo.mp4 现在开始',
      '分析视频 /tmp/demo.txt',
      '先告诉我方法，分析视频 /tmp/demo.mp4',
      '分析视频 /tmp/不要开始.mp4',
      '分析视频 /tmp/不要执行.mp4',
      '分析视频 /tmp/不要提交.mp4',
      '分析视频 /tmp/暂不执行.mp4',
      '分析视频 /tmp/只分析.mp4',
      `分析视频 /${'a'.repeat(4_090)}.mp4`,
    ]
    for (const input of rejected) {
      expect(command.parseExactVideoCommand(input), String(input)).toBeNull()
    }

    const firstKey = command.deriveVideoCommandTaskKey('/Users/Shared/中文目录/demo.mp4')
    expect(command.deriveVideoCommandTaskKey('/Users/Shared/中文目录/demo.mp4')).toBe(firstKey)
    expect(command.deriveVideoCommandTaskKey('/Users/Shared/中文目录/../中文目录/demo.mp4')).toBe(firstKey)
    expect(command.deriveVideoCommandTaskKey('/Users/Shared/中文目录/other.mp4')).not.toBe(firstKey)
    expect(firstKey).toMatch(/^video-command-[a-f0-9]{64}$/)
    expect(firstKey).not.toContain('/Users/Shared')
    expect(firstKey).not.toContain('中文目录')
  })

  it('routes exact prompt inputs to video once and leaves a non-match generic', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'openclaw-video-command-test-'))
    const inboxRoot = resolve(root, 'inbox')
    const videoPath = resolve(root, '中文 样片 (终版).mp4')
    const promptFile = resolve(root, 'video-command.txt')
    const fakePlatform = resolve(root, 'fake-platform.mjs')
    const requestLog = resolve(root, 'requests.jsonl')
    const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')

    try {
      await writeFile(videoPath, 'fake-video')
      await writeFile(promptFile, `分析视频 "${videoPath}"`)
      await writeFile(fakePlatform, `
import { appendFileSync } from 'node:fs'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ method, url: url.pathname, body }) + '\\n')
  if (method === 'GET' && url.pathname === '/api/n8n/workflows') {
    return json({ bindings: [
      { id: 'generic-binding', taskType: 'general', enabled: true },
      { id: 'video-binding', taskType: 'video-analysis', enabled: true },
    ] })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    return json({ taskId: body.taskId, status: 'accepted' })
  }
  return json({ error: 'unexpected request' }, 404)
}
`)
      const childEnv = {
        ...process.env,
        AIWORKER_MEDIA_INGEST_DIR: inboxRoot,
        FAKE_PLATFORM_LOG: requestLog,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${pathToFileURL(fakePlatform).href}`,
        ].filter(Boolean).join(' '),
      }

      const videoRun = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt', `分析视频 "${videoPath}"`,
          '--binding-id', 'generic-binding',
          '--delivery', 'none',
          '--wait-seconds', '30',
        ], {
          cwd: process.cwd(),
          env: childEnv,
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(videoRun.stderr).toBe('')
      expect(JSON.parse(videoRun.stdout)).toMatchObject({
        taskId: expect.stringMatching(/^video-command-[a-f0-9]{64}$/),
        status: 'accepted',
        bindingId: 'video-binding',
      })

      const genericRun = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt', '请分析这个普通任务',
          '--task-id', 'generic-command-task',
          '--idempotency-key', 'generic-command-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(genericRun.stderr).toBe('')
      expect(JSON.parse(genericRun.stdout)).toMatchObject({
        taskId: 'generic-command-task',
        status: 'accepted',
        bindingId: 'generic-binding',
      })

      const singleIdentityRun = await new Promise<{
        stdout: string
        stderr: string
      }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt-file', promptFile,
          '--task-id', 'custom-video-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(singleIdentityRun.stderr).toBe('')
      expect(JSON.parse(singleIdentityRun.stdout)).toMatchObject({
        taskId: 'custom-video-task',
        status: 'accepted',
        bindingId: 'video-binding',
      })

      const mismatchedIdentityRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt-file', promptFile,
          '--task-id', 'video-task-a',
          '--idempotency-key', 'video-task-b',
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(mismatchedIdentityRun.failed).toBe(true)
      expect(mismatchedIdentityRun.stdout).toBe('')
      expect(mismatchedIdentityRun.stderr).toContain('--task-id 与 --idempotency-key 必须相同')

      const pathShapedExtraRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt', `分析视频 ${videoPath} 补充.mp4`,
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(pathShapedExtraRun.failed).toBe(true)
      expect(pathShapedExtraRun.stdout).toBe('')
      expect(pathShapedExtraRun.stderr).not.toBe('')

      const replyRun = await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt-file', promptFile,
          '--task-id', 'reply-command-task',
          '--idempotency-key', 'reply-command-task',
          '--delivery', 'reply',
          '--session-key', 'test-session',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(replyRun.failed).toBe(true)
      expect(replyRun.stdout).toBe('')
      expect(replyRun.stderr).toContain('视频分析工作节点不进入 OpenClaw 会话')

      const wrongBindingRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', videoPath,
          '--binding-id', 'generic-binding',
          '--task-id', 'wrong-binding-task',
          '--idempotency-key', 'wrong-binding-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(wrongBindingRun.failed).toBe(true)
      expect(wrongBindingRun.stdout).toBe('')
      expect(wrongBindingRun.stderr).toContain('视频任务必须使用启用的 video-analysis binding')

      const requests = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as {
          method: string
          url: string
          body?: Record<string, unknown>
        })
      const triggerRequests = requests.filter(({ method, url }) => (
        method === 'POST' && url === '/api/n8n/trigger'
      ))
      expect(triggerRequests).toHaveLength(3)
      const derivedTaskId = triggerRequests[0]?.body?.taskId
      expect(derivedTaskId).toEqual(expect.stringMatching(/^video-command-[a-f0-9]{64}$/))
      expect(triggerRequests[0]?.body).toMatchObject({
        bindingId: 'video-binding',
        taskId: derivedTaskId,
        idempotencyKey: derivedTaskId,
        delivery: { mode: 'none' },
        input: { prompt: '分析视频中的语音内容和画面信息，分别给出结果后合并。' },
      })
      expect((triggerRequests[0]?.body?.input as Record<string, unknown>).videoKey).toEqual(expect.any(String))
      expect(triggerRequests[1]?.body).toMatchObject({
        bindingId: 'generic-binding',
        taskId: 'generic-command-task',
        delivery: { mode: 'none' },
        input: { prompt: '请分析这个普通任务' },
      })
      expect(triggerRequests[2]?.body).toMatchObject({
        bindingId: 'video-binding',
        taskId: 'custom-video-task',
        idempotencyKey: 'custom-video-task',
        delivery: { mode: 'none' },
      })
      expect(triggerRequests.filter(request => request.body?.taskId === derivedTaskId)).toHaveLength(1)
      expect(requests.some(({ url }) => url?.startsWith('/api/n8n/runs'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

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
    const stableEntry = 'node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs"'
    expect(skill).toContain(stableEntry)
    expect(workspaceRules).toContain(stableEntry)
    expect(workspaceRules).toContain('do not use `ls` or `find` to locate the script')
  })

  it('contracts the exact one-line command to one silent submission and one receipt', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules]) {
      expect(contract).toContain('one and only one n8n submission')
      expect(contract).toMatch(/马上开始[\s\S]*我先找[\s\S]*让我检查/)
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
