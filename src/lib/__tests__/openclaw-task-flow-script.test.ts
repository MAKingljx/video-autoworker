import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, realpathSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

async function stopTestVideoWorker(batchRoot: string): Promise<void> {
  let pid: number | null = null
  try {
    const lock = JSON.parse(await readFile(resolve(batchRoot, '.global-video-worker.lock'), 'utf8')) as {
      pid?: unknown
    }
    pid = Number.isInteger(lock.pid) && Number(lock.pid) > 0 ? Number(lock.pid) : null
  } catch {
    return
  }
  if (pid === null || pid === process.pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  throw new Error('test video worker did not stop')
}

describe('OpenClaw task-flow submit script', () => {
  it('routes explicit video arguments once and rejects video-shaped generic prompts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'openclaw-video-command-test-'))
    const batchRoot = resolve(root, 'batch-state')
    const inboxRoot = resolve(root, 'inbox')
    const videoPath = resolve(root, '中文 样片 (终版).mp4')
    const noRecoveryVideoPath = resolve(root, '独立无恢复样片.mp4')
    const promptFile = resolve(root, 'video-command.txt')
    const fakePlatform = resolve(root, 'fake-platform.mjs')
    const requestLog = resolve(root, 'requests.jsonl')
    const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
    const resultTaskId = `video-natural-${'a'.repeat(64)}`

    try {
      await writeFile(videoPath, 'fake-video')
      await writeFile(noRecoveryVideoPath, 'fake-video-no-recovery')
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
  const requestUrl = url.pathname + url.search
  appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ method, url: requestUrl, body }) + '\\n')
  if (method === 'GET' && url.pathname === '/api/n8n/intake-control') {
    return json({ control: {
      schema: 'video-autoworker-intake-control/v1',
      globalScope: true,
      accepting: true,
    } })
  }
  if (method === 'GET' && url.pathname === '/api/n8n/workflows') {
    return json({ bindings: [
      { id: 'generic-binding', taskType: 'general', enabled: true },
      { id: 'video-binding', taskType: 'video-analysis', enabled: true },
    ] })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    if (process.env.FAKE_TRIGGER_ERROR === '1') {
      return json({ error: 'injected trigger failure' }, 503)
    }
    return json({ taskId: body.taskId, status: 'accepted' })
  }
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    return json({ runs: [{
      taskId,
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 1,
      output: taskId === 'brief-video-task'
        ? { summary: '状态客户端测试摘要'.repeat(40), detail: 'x'.repeat(100_000) }
        : taskId === '${resultTaskId}'
          ? { summary: '完整学习报告'.repeat(8_000), combinedText: '不应作为首选' }
        : { summary: '状态客户端测试摘要' },
      updatedAt: '2026-08-11T12:00:00.000Z',
    }] })
  }
  return json({ error: 'unexpected request' }, 404)
}
`)
      const childEnv = {
        ...process.env,
        AIWORKER_MEDIA_INGEST_DIR: inboxRoot,
        AIWORKER_VIDEO_BATCH_DIR: batchRoot,
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
          '--video-file', videoPath,
          '--task-id', 'explicit-video-task',
          '--idempotency-key', 'explicit-video-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
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
        taskId: 'explicit-video-task',
        status: 'queued',
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

      const statusRun = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--status', 'explicit-video-task',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(statusRun.stderr).toBe('')
      expect(JSON.parse(statusRun.stdout)).toEqual({
        taskId: 'explicit-video-task',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 1,
        output: { summary: '状态客户端测试摘要' },
        updatedAt: '2026-08-11T12:00:00.000Z',
      })

      const briefStatusRun = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--status-brief', 'brief-video-task',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      const briefStatus = JSON.parse(briefStatusRun.stdout)
      expect(briefStatusRun.stderr).toBe('')
      expect(briefStatus).toMatchObject({ taskId: 'brief-video-task', status: 'succeeded' })
      expect(briefStatus.output.summary.length).toBeLessThanOrEqual(160)
      expect(briefStatus.output).not.toHaveProperty('detail')

      const resultRun = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--result', resultTaskId,
          '--result-offset', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      const resultPage = JSON.parse(resultRun.stdout)
      expect(resultRun.stderr).toBe('')
      expect(resultPage).toMatchObject({
        kind: 'report', taskId: resultTaskId, status: 'succeeded',
        report: { source: 'summary', offset: 0 },
      })
      expect(Buffer.byteLength(resultPage.report.text, 'utf8')).toBeLessThanOrEqual(24 * 1024)
      expect(resultPage.report.nextOffset).toBeGreaterThan(0)
      expect(resultPage.report.text).not.toContain('不应作为首选')

      const videoPromptRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt-file', promptFile,
          '--task-id', 'custom-video-task',
          '--idempotency-key', 'custom-video-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(videoPromptRun.failed).toBe(true)
      expect(videoPromptRun.stdout).toBe('')
      expect(videoPromptRun.stderr).toContain('视频会话请求只能由已加载的原生视频插件提交')

      const mismatchedIdentityRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', videoPath,
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
      expect(mismatchedIdentityRun.stderr).toContain('相同的 --task-id 与 --idempotency-key')

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

      const unsupportedVideoPromptRun = await new Promise<{
        failed: boolean
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--prompt', '分析 /tmp/demo.avi',
          '--task-id', 'unsupported-video-prompt',
          '--idempotency-key', 'unsupported-video-prompt',
          '--delivery', 'none',
        ], { cwd: process.cwd(), env: childEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(unsupportedVideoPromptRun.failed).toBe(true)
      expect(unsupportedVideoPromptRun.stdout).toBe('')
      expect(unsupportedVideoPromptRun.stderr).toContain('视频会话请求只能由已加载的原生视频插件提交')

      const replyRun = await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', videoPath,
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

      const noRecoveryRun = await new Promise<{
        failed: boolean
        exitCode: number | null
        stdout: string
        stderr: string
      }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', noRecoveryVideoPath,
          '--task-id', 'no-recovery-task',
          '--idempotency-key', 'no-recovery-task',
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
        ], {
          cwd: process.cwd(),
          env: { ...childEnv, FAKE_TRIGGER_ERROR: '1' },
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          resolvePromise({
            failed: Boolean(error),
            exitCode: typeof error?.code === 'number' ? error.code : null,
            stdout,
            stderr,
          })
        })
      })
      expect(noRecoveryRun.failed).toBe(false)
      expect(noRecoveryRun.exitCode).toBe(null)
      expect(JSON.parse(noRecoveryRun.stdout)).toMatchObject({
        taskId: 'no-recovery-task',
        status: 'queued',
      })
      expect(noRecoveryRun.stderr).toBe('')

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
      expect(triggerRequests).toHaveLength(1)
      expect(triggerRequests[0]?.body).toMatchObject({
        bindingId: 'generic-binding',
        taskId: 'generic-command-task',
        delivery: { mode: 'none' },
        input: { prompt: '请分析这个普通任务' },
      })
      expect(triggerRequests.filter(request => request.body?.taskId === 'explicit-video-task')).toHaveLength(0)
      expect(requests.filter(({ method, url }) => (
        method === 'GET' && url === '/api/n8n/runs?taskId=explicit-video-task'
      )).length).toBeGreaterThanOrEqual(1)
      const noRecoveryRequests = requests.filter(request => (
        request.body?.taskId === 'no-recovery-task'
        || request.url.includes('taskId=no-recovery-task')
      ))
      expect(noRecoveryRequests.filter(({ method, url }) => (
        method === 'POST' && url === '/api/n8n/trigger'
      ))).toHaveLength(0)
      // The durable lane may start a same-ID recovery query asynchronously;
      // the CLI contract only requires that the submitting process returns
      // immediately without issuing a second trigger.
    } finally {
      await stopTestVideoWorker(batchRoot)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('uses APFS clone ingestion and accepts bounded asynchronous waits', () => {
    const script = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs'), 'utf8')
    const mediaIngest = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs'), 'utf8')
    expect(script).toContain("from '../lib/media-ingest.mjs'")
    expect(mediaIngest).toContain('COPYFILE_FICLONE_FORCE')
    expect(mediaIngest).toContain("spawnImpl('/bin/cp', ['-c', '-n', sourceAnchorPath, stagedPath]")
    expect(mediaIngest).toContain('await link(sourcePath, anchorPath)')
    expect(mediaIngest).toContain('await assertHandleIdentity(sourceHandle, sourceAnchor.anchoredIdentity)')
    expect(mediaIngest).toContain("['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(code)")
    expect(mediaIngest).toContain('await utimes(incomingPath, ingestedAt, ingestedAt)')
    expect(mediaIngest).toContain('await rename(incomingPath, stagedPath)')
    expect(mediaIngest).toContain("from './media-policy.mjs'")
    expect(mediaIngest).not.toContain('10 * 1024 ** 3')
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

  it('classifies loopback service outages as retryable recovery conditions', async () => {
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

  it('documents the direct task-chain tool contract', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')

    expect(skill).toContain('`aiworker_analyze_video`')
    expect(skill).toContain('{"action":"submit_video","videoPath":"/absolute/path/video.mp4"}')
    expect(skill).toContain('{"action":"submit_directory","videoDirectory":"/absolute/path/series"}')
    expect(skill).toContain('{"action":"status","query":"task ID, batch ID, title, filename, season/episode, or keyword"}')
    expect(skill).toContain('{"action":"result","query":"task ID, batch ID, title, filename, season/episode, or keyword"}')
    expect(skill).toContain('legacy `bot-learning` search')
    expect(skill).toContain('stable IDs')
    expect(skill).toContain('persistent global video lane')
    expect(skill).toContain('completion time')
    expect(skill).toContain('do not ask the user to supply an ID already returned by the tool')
  })

  it('keeps direct dispatch inside the managed tool boundary', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    expect(workspaceRules).toContain('`aiworker_analyze_video`')
    expect(workspaceRules).toContain('`before_dispatch`')
    expect(skill).toContain('Do not require a user to remember a slash command')
    expect(skill).toContain('Use neither `exec` nor direct ffmpeg')
    expect(workspaceRules).toContain('Do not invoke shell commands')
    expect(skill).toContain('native `before_dispatch` hook')
    expect(workspaceRules).toContain('same managed runner')
    expect(workspaceRules).toContain('raw scheduler script is not exposed')
  })

  it('contracts submission to one receipt without same-turn supervision', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules]) {
      expect(contract).toMatch(/one (?:concise |short )?receipt/u)
      expect(contract).toMatch(/end the turn|After submission/u)
      expect(contract).toContain('`delivery=none`')
      expect(contract).toContain('`memoryMode=none`')
    }
    expect(skill).toContain('Do not poll,')
    expect(workspaceRules).toMatch(/do not poll, retry, resubmit/iu)
  })

  it('documents title and keyword status lookup as controlled read-only state', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toMatch(/title|标题/u)
      expect(contract).toMatch(/keyword|关键词/u)
      expect(contract).toMatch(/read-only|只读/u)
      expect(contract).toMatch(/SQLite/u)
      expect(contract).toMatch(/n8n/u)
      expect(contract).toMatch(/media/u)
    }
    expect(skill).toMatch(/returns bounded\s+candidates for ambiguity/u)
    expect(workspaceRules).toContain('ambiguous result matches return bounded candidates containing task ID')
    expect(workspaceRules).toContain('completion time, and update time')
  })

  it('keeps native hook compatibility separate from the direct tool', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toContain('`before_dispatch`')
      expect(contract).toMatch(/fail(?:s)? closed|fail-closed/u)
      expect(contract).toContain('`aiworker_analyze_video`')
      expect(contract).toMatch(/runner errors?|runner 失败/u)
    }
    expect(skill).toContain('The tool is the direct OpenClaw')
    expect(workspaceRules).toContain('raw scheduler script is not exposed')
  })

  it('allows IDs and title queries without asking users for slash commands', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toMatch(/task ID|任务 ID/u)
      expect(contract).toMatch(/batch ID|批次 ID/u)
      expect(contract).toMatch(/title|标题/u)
      expect(contract).toMatch(/keyword|关键词/u)
    }
    expect(skill).toContain('never demand a')
    expect(skill).toContain('`/video-status` command')
  })

  it('documents one process-wide persistent lane for single videos and directories', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toMatch(/single video|single videos/u)
      expect(contract).toMatch(/director(?:y|ies)/u)
      expect(contract).toMatch(/persistent/u)
      expect(contract).toMatch(/process-wide/u)
      expect(contract).toMatch(/one video at a time/u)
      expect(contract).toMatch(/restart/u)
    }
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
    const liveDbPath = resolve(root, 'mission-control.db')
    const n8nDbPath = resolve(root, 'n8n.sqlite')
    const deploymentRunDir = resolve(realpathSync.native(root), 'blue-green-run')
    const installer = resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh')
    const runInstaller = (backupRoot: string) => new Promise<void>((resolvePromise, rejectPromise) => {
      execFile('bash', [installer, '--apply'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AIWORKER_QWEN_WORKSPACE: workspace,
          AIWORKER_SKILL_BACKUP_ROOT: backupRoot,
          AIWORKER_BG_RUN_DIR: deploymentRunDir,
          AIWORKER_BG_LIVE_DB_PATH: realpathSync.native(liveDbPath),
          AIWORKER_BG_N8N_DB_PATH: realpathSync.native(n8nDbPath),
          AIWORKER_VIDEO_BATCH_DIR: realpathSync.native(resolve(root, 'video-batches')),
        },
        encoding: 'utf8',
      }, error => error ? rejectPromise(error) : resolvePromise())
    })

    try {
      const database = new Database(liveDbPath)
      database.exec(`
        CREATE TABLE n8n_intake_controls (
          control_id INTEGER PRIMARY KEY,
          accepting INTEGER NOT NULL,
          revision INTEGER NOT NULL
        );
        INSERT INTO n8n_intake_controls VALUES (1, 0, 1);
        CREATE TABLE n8n_task_runs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE n8n_director_evidence_outbox (status TEXT NOT NULL);
      `)
      database.close()
      chmodSync(liveDbPath, 0o600)
      const n8n = new Database(n8nDbPath)
      n8n.exec(`
        CREATE TABLE execution_entity (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          "stoppedAt" INTEGER
        );
      `)
      n8n.close()
      chmodSync(n8nDbPath, 0o600)
      await mkdir(resolve(root, 'video-batches'), { mode: 0o700 })
      await mkdir(workspace, { recursive: true })
      await writeFile(resolve(workspace, 'AGENTS.md'), '# Workspace Rules\n\nKeep this rule.\n')
      await runInstaller(resolve(root, 'backups-1'))
      await runInstaller(resolve(root, 'backups-2'))

      const agents = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('Keep this rule.')
      expect(agents).toContain('`aiworker_analyze_video`')
      expect(agents).toContain('`before_dispatch`')
      expect(agents).toContain('raw scheduler script is not exposed')
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

  it('persists one immutable batch identity and rejects batch-id input drift', async () => {
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
      const duplicate = await batch.createBatchState(input)
      expect(created.duplicate).toBe(false)
      expect(duplicate.duplicate).toBe(true)
      expect(duplicate.state.prompt).toBe('first prompt')
      await expect(batch.createBatchState({ ...input, prompt: 'changed prompt' }))
        .rejects.toThrow('同一批次 ID 已绑定其他视频目录、提示词或执行配置')
      for (const drift of [
        { baseUrl: 'http://127.0.0.1:3999' },
        { bindingId: 'changed-binding' },
        { visionRoute: 'changed-vision' },
        { inboxRoot: resolve(root, 'changed-inbox') },
      ]) {
        await expect(batch.createBatchState({ ...input, ...drift }))
          .rejects.toThrow('执行配置')
      }
      expect(batch.summarizeBatchState(created.state).items[0]).not.toHaveProperty('sourcePath')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('searches every controlled state JSON by title and keeps source paths out of the result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-status-search-test-'))
    try {
      const taskId = `video-natural-${'a'.repeat(64)}`
      const stateRoot = resolve(root, 'state')
      await mkdir(stateRoot, { recursive: true })
      await writeFile(resolve(stateRoot, `${'b'.repeat(64)}.json`), JSON.stringify({
        schemaVersion: 2,
        requestFingerprint: 'c'.repeat(64),
        kind: 'single',
        batchId: 'single:search-fixture',
        status: 'queued',
        prompt: '内部提示关键词',
        updatedAt: '2026-08-16T12:00:00.000Z',
        items: [{
          index: 1,
          taskId,
          name: '地球之极 S03E03.mp4',
          sourcePath: '/private/secret/video/地球之极 S03E03.mp4',
          status: 'queued',
        }],
      }))
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        searchVideoTaskStates: (query: string, root: string) => Promise<{
          matches: Array<Record<string, unknown>>
          total: number
          truncated: boolean
        }>
      }
      const searched = await batch.searchVideoTaskStates(
        '查询《地球之极》第三季第三集进度',
        stateRoot,
      )
      expect(searched).toMatchObject({ total: 1, truncated: false })
      expect(searched.matches[0]).toMatchObject({
        kind: 'task', taskId, name: '地球之极 S03E03.mp4', status: 'queued',
      })
      expect(searched.matches[0]).not.toHaveProperty('sourcePath')
      expect(searched.matches[0]).not.toHaveProperty('prompt')
      await expect(batch.searchVideoTaskStates('private secret', stateRoot)).resolves.toMatchObject({
        matches: [], total: 0, truncated: false,
      })
      await expect(batch.searchVideoTaskStates('内部提示关键词', stateRoot)).resolves.toMatchObject({
        matches: [], total: 0, truncated: false,
      })

      const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
      const cli = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [script, '--search-status', '地球之极 第三季 第三集'], {
          cwd: process.cwd(),
          env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: stateRoot },
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(cli.stderr).toBe('')
      expect(JSON.parse(cli.stdout)).toMatchObject({ total: 1, truncated: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns complete controlled metadata for ambiguous result candidates', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-result-candidates-test-'))
    try {
      const stateRoot = resolve(root, 'state')
      await mkdir(stateRoot, { recursive: true })
      const newerTaskId = `video-command-${'a'.repeat(64)}`
      const olderTaskId = `video-natural-${'b'.repeat(64)}`
      const batchId = `video-batch-${'f'.repeat(64)}`
      const batchTaskId = `${batchId}:video:002:${'0'.repeat(12)}`
      const fixtures = [
        {
          file: `${'c'.repeat(64)}.json`,
          taskId: newerTaskId,
          kind: 'single',
          batchId: 'single:newer-result-fixture',
          index: 1,
          updatedAt: '2026-08-19T07:01:00.000Z',
          completedAt: '2026-08-19T07:00:00.000Z',
        },
        {
          file: `${'d'.repeat(64)}.json`,
          taskId: olderTaskId,
          kind: 'single',
          batchId: 'single:older-result-fixture',
          index: 1,
          updatedAt: '2026-08-18T07:01:00.000Z',
          completedAt: '2026-08-18T07:00:00.000Z',
        },
        {
          file: `${'e'.repeat(64)}.json`,
          taskId: batchTaskId,
          kind: 'batch',
          batchId,
          index: 2,
          updatedAt: '2026-08-17T07:01:00.000Z',
          completedAt: '2026-08-17T07:00:00.000Z',
        },
      ]
      for (const fixture of fixtures) {
        await writeFile(resolve(stateRoot, fixture.file), JSON.stringify({
          schemaVersion: 2,
          requestFingerprint: 'e'.repeat(64),
          kind: fixture.kind,
          batchId: fixture.batchId,
          status: 'succeeded',
          updatedAt: fixture.updatedAt,
          items: [{
            index: fixture.index,
            taskId: fixture.taskId,
            name: '《地球之极》第三季第三集 1025.mp4',
            status: 'succeeded',
            completedAt: fixture.completedAt,
          }],
        }))
      }

      const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
      const cli = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [script, '--result', 'S03E03', '--result-offset', '0'], {
          cwd: process.cwd(),
          env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: stateRoot },
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(cli.stderr).toBe('')
      expect(JSON.parse(cli.stdout)).toEqual({
        kind: 'matches',
        matches: [
          {
            kind: 'task', taskId: newerTaskId, batchId: null, index: null,
            name: '《地球之极》第三季第三集 1025.mp4', status: 'succeeded',
            completedAt: '2026-08-19T07:00:00.000Z', updatedAt: '2026-08-19T07:01:00.000Z',
          },
          {
            kind: 'task', taskId: olderTaskId, batchId: null, index: null,
            name: '《地球之极》第三季第三集 1025.mp4', status: 'succeeded',
            completedAt: '2026-08-18T07:00:00.000Z', updatedAt: '2026-08-18T07:01:00.000Z',
          },
          {
            kind: 'batch', taskId: batchTaskId, batchId, index: 2,
            name: '《地球之极》第三季第三集 1025.mp4', status: 'succeeded',
            completedAt: '2026-08-17T07:00:00.000Z', updatedAt: '2026-08-17T07:01:00.000Z',
          },
        ],
        total: 3,
        truncated: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses one process-wide batch lock for every persisted batch state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-global-lock-test-'))
    try {
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        acquireGlobalBatchLock: (path: string) => Promise<{ acquired: boolean; release: () => Promise<void> }>
        globalBatchLockPath: (path: string) => string
      }
      const firstPath = resolve(root, 'first.json')
      const secondPath = resolve(root, 'second.json')
      expect(batch.globalBatchLockPath(firstPath)).toBe(batch.globalBatchLockPath(secondPath))
      const first = await batch.acquireGlobalBatchLock(firstPath)
      const second = await batch.acquireGlobalBatchLock(secondPath)
      expect(first.acquired).toBe(true)
      expect(second.acquired).toBe(false)
      await first.release()
      const resumed = await batch.acquireGlobalBatchLock(secondPath)
      expect(resumed.acquired).toBe(true)
      await resumed.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores single videos as schema-v2 one-item jobs and detects source drift', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-single-video-lane-test-'))
    try {
      const video = resolve(root, 'single.mp4')
      await writeFile(video, 'first')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{
          duplicate: boolean
          state: { schemaVersion: number; kind: string; requestFingerprint: string; items: Array<Record<string, unknown>> }
        }>
        verifyBatchItemSource: (item: Record<string, unknown>) => Promise<unknown>
      }
      const input = {
        taskId: 'single-lane-task',
        idempotencyKey: 'single-lane-task',
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        inboxRoot: resolve(root, 'inbox'),
        batchRoot: resolve(root, 'state'),
      }
      const created = await batch.createSingleVideoState(input)
      expect(created.state).toMatchObject({ schemaVersion: 2, kind: 'single' })
      expect(created.state.requestFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(created.state.items).toHaveLength(1)
      await expect(batch.createSingleVideoState({ ...input, prompt: 'changed' }))
        .rejects.toThrow('同一任务 ID 已绑定其他视频、提示词或执行配置')
      for (const drift of [
        { baseUrl: 'http://127.0.0.1:3999' },
        { bindingId: 'changed-binding' },
        { visionRoute: 'changed-vision' },
        { inboxRoot: resolve(root, 'changed-inbox') },
      ]) {
        await expect(batch.createSingleVideoState({ ...input, ...drift }))
          .rejects.toThrow('执行配置')
      }
      await writeFile(video, 'changed-source')
      await expect(batch.verifyBatchItemSource(created.state.items[0]))
        .rejects.toThrow('视频源文件在入队后发生变化')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an existing material ID only through a one-time task-and-path-bound handoff', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-single-material-cli-test-'))
    const stateRoot = resolve(root, 'state')
    const video = resolve(root, 'single.mp4')
    const fakePlatform = resolve(root, 'fake-material-cli-platform.mjs')
    const materialId = 'MATERIAL-EXISTING-CLI-001'
    let laneLock: { release: () => Promise<void> } | null = null
    try {
      await mkdir(stateRoot)
      const handoffRoot = resolve(root, 'handoffs')
      await mkdir(handoffRoot)
      await chmod(handoffRoot, 0o700)
      await writeFile(video, 'single-material-cli-video')
      await writeFile(fakePlatform, `
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (method === 'GET' && url.pathname === '/api/n8n/intake-control') {
    return json({ control: {
      schema: 'video-autoworker-intake-control/v1',
      globalScope: true,
      accepting: true,
    } })
  }
  if (method === 'GET' && url.pathname === '/api/n8n/workflows') {
    return json({ bindings: [{ id: 'video-binding', taskType: 'video-analysis', enabled: true }] })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        acquireGlobalBatchLock: (path: string) => Promise<{
          acquired: boolean
          release: () => Promise<void>
        }>
        readSingleVideoTaskState: (taskId: string, root: string) => Promise<{
          item: Record<string, unknown>
        }>
      }
      const acquired = await batch.acquireGlobalBatchLock(resolve(stateRoot, 'test-anchor.json'))
      expect(acquired.acquired).toBe(true)
      laneLock = acquired

      const taskId = `video-command-${'f'.repeat(64)}`
      const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
      const legacy = await new Promise<{ error: Error | null; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--video-file', video,
          '--task-id', taskId,
          '--idempotency-key', taskId,
          '--material-id', materialId,
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
        ], { encoding: 'utf8' }, (error, _stdout, stderr) => resolvePromise({ error, stderr }))
      })
      expect(legacy.error).not.toBeNull()
      expect(legacy.stderr).toContain('未知参数：--material-id')

      const untrustedInternal = await new Promise<{ error: Error | null; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--video-file', video,
          '--task-id', taskId,
          '--idempotency-key', taskId,
          '--trusted-existing-material-id', materialId,
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
        ], {
          env: { ...process.env, AIWORKER_TRUSTED_MEDIA_ADAPTER: 'scheduler-runner-v1' },
          encoding: 'utf8',
        }, (error, _stdout, stderr) => resolvePromise({ error, stderr }))
      })
      expect(untrustedInternal.error).not.toBeNull()
      expect(untrustedInternal.stderr).toContain('未知参数：--trusted-existing-material-id')

      const runnerUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js',
      )).href
      const scheduler = await import(/* @vite-ignore */ runnerUrl) as {
        createMediaHandoff: (input: Record<string, unknown>) => Promise<{
          path: string
          cleanup: (input: { disposition: string }) => Promise<unknown>
        }>
      }
      const handoff = await scheduler.createMediaHandoff({
        taskId,
        videoPath: video,
        materialId,
        root: handoffRoot,
      })
      expect((await stat(handoff.path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(handoff.path, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        taskId,
        videoPath: await realpath(video),
        materialId,
      })

      const result = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', video,
          '--task-id', taskId,
          '--idempotency-key', taskId,
          '--media-handoff', handoff.path,
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
        ], {
          env: {
            ...process.env,
            AIWORKER_MEDIA_INGEST_DIR: resolve(root, 'inbox'),
            AIWORKER_VIDEO_BATCH_DIR: stateRoot,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
          encoding: 'utf8',
        }, (error, stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise({ stdout, stderr }))
      })

      expect(result.stderr).toBe('')
      await expect(access(handoff.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(result.stdout)).toMatchObject({ taskId, status: 'queued' })
      const durable = await batch.readSingleVideoTaskState(taskId, stateRoot)
      expect(durable.item.trustedExistingMaterialId).toBe(materialId)
      expect(durable.item).not.toHaveProperty('materialId')
      await handoff.cleanup({ disposition: 'persisted_ack' })

      const replay = await new Promise<{ error: Error | null; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', video,
          '--task-id', taskId,
          '--idempotency-key', taskId,
          '--media-handoff', handoff.path,
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
        ], {
          env: {
            ...process.env,
            AIWORKER_MEDIA_INGEST_DIR: resolve(root, 'inbox'),
            AIWORKER_VIDEO_BATCH_DIR: stateRoot,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
          encoding: 'utf8',
        }, (error, _stdout, stderr) => resolvePromise({ error, stderr }))
      })
      expect(replay.error).not.toBeNull()
      expect(replay.stderr).toMatch(/ENOENT|no such file/iu)

      const runRejectedHandoff = async (handoffPath: string, requestedTaskId: string, requestedVideo: string) => (
        new Promise<{ error: Error | null; stderr: string }>(resolvePromise => {
          execFile(process.execPath, [
            script,
            '--base-url', 'http://127.0.0.1:3017',
            '--video-file', requestedVideo,
            '--task-id', requestedTaskId,
            '--idempotency-key', requestedTaskId,
            '--media-handoff', handoffPath,
            '--delivery', 'none',
            '--wait-seconds', '0',
            '--no-trigger-recovery',
          ], {
            env: {
              ...process.env,
              AIWORKER_MEDIA_INGEST_DIR: resolve(root, 'inbox'),
              AIWORKER_VIDEO_BATCH_DIR: stateRoot,
              NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
                .filter(Boolean).join(' '),
            },
            encoding: 'utf8',
          }, (error, _stdout, stderr) => resolvePromise({ error, stderr }))
        })
      )
      const otherVideo = resolve(root, 'other.mp4')
      await writeFile(otherVideo, 'other-video')
      const wrongPathHandoff = await scheduler.createMediaHandoff({
        taskId,
        videoPath: otherVideo,
        materialId,
        root: handoffRoot,
      })
      const wrongPath = await runRejectedHandoff(wrongPathHandoff.path, taskId, video)
      expect(wrongPath.error).not.toBeNull()
      expect(wrongPath.stderr).toContain('媒体身份交接凭证与任务或视频不匹配')
      await expect(access(wrongPathHandoff.path)).rejects.toMatchObject({ code: 'ENOENT' })

      const otherTaskId = `video-command-${'e'.repeat(64)}`
      const wrongTaskHandoff = await scheduler.createMediaHandoff({
        taskId: otherTaskId,
        videoPath: video,
        materialId,
        root: handoffRoot,
      })
      const wrongTask = await runRejectedHandoff(wrongTaskHandoff.path, taskId, video)
      expect(wrongTask.error).not.toBeNull()
      expect(wrongTask.stderr).toContain('媒体身份交接凭证与任务或视频不匹配')
      await expect(access(wrongTaskHandoff.path)).rejects.toMatchObject({ code: 'ENOENT' })

      const replacedTaskId = `video-command-${'d'.repeat(64)}`
      const replacementHandoff = await scheduler.createMediaHandoff({
        taskId: replacedTaskId,
        videoPath: video,
        materialId,
        root: handoffRoot,
      })
      const originalVideo = resolve(root, 'original-before-replacement.mp4')
      const replacementVideo = resolve(root, 'atomic-replacement.mp4')
      await writeFile(replacementVideo, Buffer.alloc((await stat(video)).size, 0x78))
      await rename(video, originalVideo)
      await rename(replacementVideo, video)
      const replaced = await runRejectedHandoff(replacementHandoff.path, replacedTaskId, video)
      expect(replaced.error).not.toBeNull()
      expect(replaced.stderr).toContain('媒体身份交接凭证对应的视频已变化')
      await expect(access(replacementHandoff.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(video)
      await rename(originalVideo, video)
    } finally {
      await laneLock?.release().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a consumed material handoff from a private task journal and fails closed on unsafe recovery data', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-material-handoff-journal-test-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const video = resolve(root, 'journal.mp4')
    const fakePlatform = resolve(root, 'fake-journal-platform.mjs')
    let laneLock: { release: () => Promise<void> } | null = null
    try {
      await mkdir(stateRoot, { mode: 0o700 })
      await writeFile(video, 'journal-video')
      await writeFile(fakePlatform, `
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (method === 'GET' && url.pathname === '/api/n8n/intake-control') {
    return json({ control: {
      schema: 'video-autoworker-intake-control/v1',
      globalScope: true,
      accepting: true,
    } })
  }
  if (method === 'GET' && url.pathname === '/api/n8n/workflows') {
    return json({ bindings: [{ id: 'video-binding', taskType: 'video-analysis', enabled: true }] })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        acquireGlobalBatchLock: (path: string) => Promise<{
          acquired: boolean
          release: () => Promise<void>
        }>
        prepareMaterialHandoffJournalContext: (input: Record<string, unknown>) => Promise<Record<string, unknown> & {
          journalPath: string
          sourceIdentity: Record<string, number>
        }>
        readMaterialHandoffJournal: (context: Record<string, unknown>) => Promise<Record<string, unknown> | null>
        writeMaterialHandoffJournal: (
          context: Record<string, unknown>,
          handoff: { materialId: string; nonce: string },
        ) => Promise<Record<string, unknown>>
        withMaterialHandoffJournalLock: <T>(
          taskId: string,
          root: string,
          callback: () => Promise<T>,
        ) => Promise<T>
        readSingleVideoTaskState: (taskId: string, root: string) => Promise<{
          item: Record<string, unknown>
        }>
        createSingleVideoState: (input: Record<string, unknown>) => Promise<unknown>
      }
      const taskId = `video-command-${'c'.repeat(64)}`
      const contextInput = {
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频中的语音内容和画面信息，分别给出结果后合并。',
        visionRoute: null,
        videoFile: video,
        inboxRoot,
        batchRoot: stateRoot,
      }
      const context = await batch.prepareMaterialHandoffJournalContext(contextInput)
      const nonce = '00000000-0000-4000-8000-000000000001'
      const materialId = 'MATERIAL-EXISTING-JOURNAL-001'
      const historicalTaskId = `video-command-${'a'.repeat(64)}`
      await batch.createSingleVideoState({
        ...contextInput,
        taskId: historicalTaskId,
        idempotencyKey: historicalTaskId,
      })
      const handoffRoot = resolve(root, 'handoffs')
      await mkdir(handoffRoot, { mode: 0o700 })
      const runnerUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js',
      )).href
      const scheduler = await import(/* @vite-ignore */ runnerUrl) as {
        createMediaHandoff: (input: Record<string, unknown>) => Promise<{
          path: string
          nonce: string
          cleanup: (input: { disposition: string }) => Promise<unknown>
        }>
      }
      const handoff = await scheduler.createMediaHandoff({
        taskId,
        videoPath: video,
        materialId,
        root: handoffRoot,
      })

      const acquired = await batch.acquireGlobalBatchLock(resolve(stateRoot, 'journal-anchor.json'))
      expect(acquired.acquired).toBe(true)
      laneLock = acquired
      const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
      const run = (extraArguments: string[] = []) => new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [
          script,
          '--base-url', 'http://127.0.0.1:3017',
          '--video-file', video,
          '--task-id', taskId,
          '--idempotency-key', taskId,
          '--delivery', 'none',
          '--wait-seconds', '0',
          '--no-trigger-recovery',
          ...extraArguments,
        ], {
          env: {
            ...process.env,
            AIWORKER_MEDIA_INGEST_DIR: inboxRoot,
            AIWORKER_VIDEO_BATCH_DIR: stateRoot,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
          encoding: 'utf8',
        }, (error, stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise({ stdout, stderr }))
      })
      const blocked = await run(['--media-handoff', handoff.path])
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        taskId,
        status: 'confirmation_required',
        confirmationRequired: true,
      })
      await expect(access(handoff.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(context.journalPath)).mode & 0o777).toBe(0o600)

      // Simulate a producer that lost the consumer ACK and rebuilt a delivery
      // credential with a fresh transport nonce while the original WAL exists.
      await handoff.cleanup({ disposition: 'persisted_ack' })
      const replacementHandoff = await scheduler.createMediaHandoff({
        taskId,
        videoPath: video,
        materialId,
        root: handoffRoot,
      })
      expect(replacementHandoff.nonce).not.toBe(handoff.nonce)
      const concurrent = await Promise.all([
        run(['--confirm-duplicate']),
        run(['--media-handoff', replacementHandoff.path, '--confirm-duplicate']),
      ])
      expect(concurrent.map(result => JSON.parse(result.stdout).duplicate).sort()).toEqual([false, true])
      expect(concurrent.every(result => result.stderr === '')).toBe(true)
      expect(JSON.parse(concurrent[1].stdout).materialHandoffPersisted).toBe(true)
      await replacementHandoff.cleanup({ disposition: 'persisted_ack' })
      await expect(access(context.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const durable = await batch.readSingleVideoTaskState(taskId, stateRoot)
      expect(durable.item.trustedExistingMaterialId).toBe(materialId)

      const unsafeTaskId = `video-command-${'b'.repeat(64)}`
      const unsafeContext = await batch.prepareMaterialHandoffJournalContext({
        ...contextInput,
        taskId: unsafeTaskId,
        idempotencyKey: unsafeTaskId,
      })
      await batch.writeMaterialHandoffJournal(unsafeContext, { materialId, nonce })
      const mismatched = await batch.prepareMaterialHandoffJournalContext({
        ...contextInput,
        taskId: unsafeTaskId,
        idempotencyKey: unsafeTaskId,
        prompt: '不同请求',
      })
      await expect(batch.readMaterialHandoffJournal(mismatched)).rejects.toThrow('请求不匹配')

      await chmod(unsafeContext.journalPath, 0o644)
      await expect(batch.readMaterialHandoffJournal(unsafeContext)).rejects.toThrow('权限无效')
      await chmod(unsafeContext.journalPath, 0o600)
      await writeFile(unsafeContext.journalPath, '{broken-json')
      await expect(batch.readMaterialHandoffJournal(unsafeContext)).rejects.toThrow('记录损坏')

      await rm(unsafeContext.journalPath)
      const symlinkTarget = resolve(root, 'journal-target.json')
      await writeFile(symlinkTarget, '{}', { mode: 0o600 })
      await symlink(symlinkTarget, unsafeContext.journalPath)
      await expect(batch.readMaterialHandoffJournal(unsafeContext)).rejects.toThrow('权限无效')
      await rm(unsafeContext.journalPath)

      await batch.writeMaterialHandoffJournal(unsafeContext, { materialId, nonce })
      await expect(batch.writeMaterialHandoffJournal(unsafeContext, {
        materialId,
        nonce: '00000000-0000-4000-8000-000000000002',
      })).resolves.toMatchObject({ materialId, nonce })
      await expect(batch.writeMaterialHandoffJournal(unsafeContext, {
        materialId: 'MATERIAL-CONFLICT',
        nonce: '00000000-0000-4000-8000-000000000003',
      })).rejects.toThrow('冲突')
      await writeFile(video, 'journal-video-changed')
      await expect(batch.readMaterialHandoffJournal(unsafeContext)).rejects.toThrow('视频已变化')
    } finally {
      await laneLock?.release().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates invalid state files, skips terminal v1, and safely migrates runnable v1', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-v1-migration-test-'))
    const stateRoot = resolve(root, 'state')
    try {
      await mkdir(stateRoot)
      const video = resolve(root, 'legacy.mp4')
      await writeFile(video, 'legacy-video')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        batchStatePath: (id: string, root: string) => string
        listBatchStatePaths: (path: string, options?: { onWarning?: (warning: string) => void }) => Promise<string[]>
        prepareBatchStateForExecution: (path: string) => Promise<Record<string, unknown> & {
          schemaVersion: number
          requestFingerprint: string
          status: string
          items: Array<Record<string, unknown>>
        }>
      }
      const base = {
        schemaVersion: 1,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        sourceDirectory: root,
        inboxRoot: resolve(root, 'inbox'),
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        error: null,
        items: [{
          index: 1,
          name: 'legacy.mp4',
          sourcePath: video,
          sourceBytes: 12,
          taskId: 'legacy:video:001:test',
          idempotencyKey: 'legacy:video:001:test',
          status: 'queued',
          error: null,
          submittedAt: null,
          completedAt: null,
        }],
      }
      const runnablePath = batch.batchStatePath('legacy-runnable', stateRoot)
      const terminalPath = batch.batchStatePath('legacy-terminal', stateRoot)
      await writeFile(runnablePath, JSON.stringify({ ...base, batchId: 'legacy-runnable', status: 'queued' }))
      await writeFile(terminalPath, JSON.stringify({ ...base, batchId: 'legacy-terminal', status: 'succeeded' }))
      await writeFile(resolve(stateRoot, `${'a'.repeat(64)}.json`), '{invalid')
      const warnings: string[] = []
      const paths = await batch.listBatchStatePaths(runnablePath, { onWarning: warning => warnings.push(warning) })
      expect(paths).toEqual([runnablePath])
      expect(warnings).toHaveLength(1)
      const migrated = await batch.prepareBatchStateForExecution(runnablePath)
      expect(migrated.schemaVersion).toBe(2)
      expect(migrated.requestFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(migrated.items[0]?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps unsafe v1 migration paused without poisoning later jobs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-v1-unsafe-test-'))
    try {
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        batchStatePath: (id: string, root: string) => string
        prepareBatchStateForExecution: (path: string) => Promise<{ status: string; error: string }>
      }
      const stateRoot = resolve(root, 'state')
      await mkdir(stateRoot)
      const statePath = batch.batchStatePath('legacy-unsafe', stateRoot)
      await writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        batchId: 'legacy-unsafe',
        status: 'queued',
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        sourceDirectory: root,
        inboxRoot: resolve(root, 'inbox'),
        items: [{ taskId: 'legacy-task', sourcePath: resolve(root, 'missing.mp4'), sourceBytes: 1 }],
      }))
      const migrated = await batch.prepareBatchStateForExecution(statePath)
      expect(migrated.status).toBe('paused')
      expect(migrated.error).toContain('旧版批次不能安全迁移')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects conflicting or ignored CLI modes before any request', async () => {
    const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
    const cases = [
      ['--batch-status', 'batch-a', '--status', 'task-a'],
      ['--batch-status', 'batch-a', '--base-url', 'http://127.0.0.1:9'],
      ['--video-dir', '/tmp', '--batch-id', 'batch-a', '--wait-seconds', '0'],
      ['--prompt', 'a', '--prompt-file', '/tmp/prompt.txt'],
      ['--unknown-option', 'value'],
      ['--resume-pending', '--status', 'task-a'],
    ]
    for (const cliArgs of cases) {
      const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
        execFile(process.execPath, [script, ...cliArgs], { encoding: 'utf8' }, (error, stdout, stderr) => {
          resolvePromise({ failed: Boolean(error), stdout, stderr })
        })
      })
      expect(result.failed).toBe(true)
      expect(result.stdout).toBe('')
      expect(result.stderr).not.toBe('')
    }
  })

  it('serves queued single-video status from local durable state before platform acceptance', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-single-local-status-test-'))
    const stateRoot = resolve(root, 'state')
    try {
      const video = resolve(root, 'queued.mp4')
      await writeFile(video, 'queued-video')
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<unknown>
      }
      const taskId = 'video-natural-' + 'a'.repeat(64)
      await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        inboxRoot: resolve(root, 'inbox'),
        batchRoot: stateRoot,
      })
      const script = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs')
      const result = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [script, '--status', taskId], {
          env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: stateRoot },
          encoding: 'utf8',
        }, (error, stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise({ stdout, stderr })
        })
      })
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ taskId, status: 'queued', output: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exposes a stable serve-root controller interface and distinct recovery states', () => {
    const worker = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs',
    ), 'utf8')
    expect(worker).toContain("option('--serve-root')")
    expect(worker).toContain("['queued', 'running', 'recovering']")
    expect(worker).toContain("failedState.status = isRetryablePlatformError(error) ? 'recovering' : 'paused'")
    expect(worker).toContain("const journalPending = state.items.some(item => item?.stagingRecovery && item.status !== 'attention')")
    expect(worker).toContain("if ((batchTerminal(state.status) || !recoveryRunnable(state.status)) && !journalPending) continue")
    expect(worker).toContain('Number.isFinite(configuredReconcileInterval)')
    expect(worker).toMatch(/\? configuredReconcileInterval\s+: 60_000/)
  })

  it('carries an existing material ID from single state through the worker trigger', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-existing-material-worker-test-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'request.json')
    const fakePlatform = resolve(root, 'fake-material-platform.mjs')
    const video = resolve(root, 'existing-material.mp4')
    const materialId = 'MATERIAL-EXISTING-WORKER-001'
    try {
      await writeFile(video, 'video-content-with-a-different-sha256-identity')
      await writeFile(fakePlatform, `
import { writeFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : null
  if (method === 'GET' && url.pathname === '/api/n8n/runs') return json({ runs: [] })
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    writeFileSync(process.env.FAKE_MATERIAL_REQUEST_LOG, JSON.stringify(body))
    return json({ taskId: body.taskId, status: 'succeeded', duplicate: false })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{
          statePath: string
        }>
      }
      const taskId = `video-natural-${'d'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        trustedExistingMaterialId: materialId,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            FAKE_MATERIAL_REQUEST_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const payload = JSON.parse(await readFile(requestLog, 'utf8'))
      expect(payload).toMatchObject({
        taskId,
        input: { materialId },
      })
      expect(payload.input.materialId).not.toMatch(/^MATERIAL-SHA256-/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the same material ID after a retryable trigger failure and durable recovery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-material-recovery-test-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const triggerCount = resolve(root, 'trigger-count.txt')
    const fakePlatform = resolve(root, 'fake-material-recovery-platform.mjs')
    const video = resolve(root, 'recovery-material.mp4')
    const materialId = 'MATERIAL-EXISTING-RECOVERY-001'
    try {
      await writeFile(video, 'video-content-for-retryable-material-recovery')
      await writeFile(triggerCount, '0')
      await writeFile(fakePlatform, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : null
  if (method === 'GET' && url.pathname === '/api/n8n/runs') return json({ runs: [] })
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    const count = Number(readFileSync(process.env.FAKE_MATERIAL_TRIGGER_COUNT, 'utf8')) + 1
    writeFileSync(process.env.FAKE_MATERIAL_TRIGGER_COUNT, String(count))
    appendFileSync(process.env.FAKE_MATERIAL_REQUEST_LOG, JSON.stringify(body) + '\\n')
    if (count === 1) return json({ error: 'temporary trigger failure' }, 503)
    return json({ taskId: body.taskId, status: 'succeeded', duplicate: false })
  }
  return json({ error: 'unexpected request' }, 404)
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<{ status: string }>
      }
      const taskId = `video-natural-${'c'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        trustedExistingMaterialId: materialId,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      const runWorker = () => new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            FAKE_MATERIAL_REQUEST_LOG: requestLog,
            FAKE_MATERIAL_TRIGGER_COUNT: triggerCount,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      await runWorker()
      expect((await batch.readBatchState(created.statePath)).status).toBe('recovering')
      await runWorker()
      expect((await batch.readBatchState(created.statePath)).status).toBe('succeeded')

      const payloads = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(payloads).toHaveLength(2)
      expect(payloads.map(payload => payload.input.materialId)).toEqual([materialId, materialId])
      expect(payloads.map(payload => payload.taskId)).toEqual([taskId, taskId])
      expect(payloads.map(payload => payload.idempotencyKey)).toEqual([taskId, taskId])
      expect(payloads[1].input.videoKey).toBe(payloads[0].input.videoKey)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resumes a same-key queued run in the current worker turn after an empty trigger response', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-current-turn-queued-resume-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const fakePlatform = resolve(root, 'fake-current-turn-queued-platform.mjs')
    const video = resolve(root, 'queued-resume.mp4')
    try {
      await writeFile(video, 'queued-resume-current-turn')
      await writeFile(requestLog, '')
      await writeFile(fakePlatform, `
import { appendFileSync, readFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const payloads = () => readFileSync(process.env.FAKE_QUEUED_REQUEST_LOG, 'utf8')
  .trim().split('\\n').filter(Boolean).map(line => JSON.parse(line))
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    const body = JSON.parse(String(init.body))
    appendFileSync(process.env.FAKE_QUEUED_REQUEST_LOG, JSON.stringify(body) + '\\n')
    return payloads().length === 1
      ? new Response('', { status: 200 })
      : json({ taskId: body.taskId, status: 'succeeded' })
  }
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const [first] = payloads()
    return json({ runs: first ? [{
      taskId: first.taskId,
      status: 'queued',
      input: { videoKey: first.input.videoKey },
    }] : [] })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<Record<string, any>>
      }
      const taskId = `video-natural-${'9'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            FAKE_QUEUED_REQUEST_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const completed = await batch.readBatchState(created.statePath)
      expect(completed.status).toBe('succeeded')
      expect(completed.items[0]).not.toHaveProperty('stagingRecovery')
      const payloads = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(payloads).toHaveLength(2)
      expect(payloads[1].taskId).toBe(payloads[0].taskId)
      expect(payloads[1].idempotencyKey).toBe(payloads[0].idempotencyKey)
      expect(payloads[1].input.videoKey).toBe(payloads[0].input.videoKey)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps journal-bound media when a crashed trigger is already owned by the platform', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-platform-owned-crash-recovery-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const fakePlatform = resolve(root, 'fake-platform-owned-recovery.mjs')
    const video = resolve(root, 'platform-owned.mp4')
    const videoKey = '00000000-0000-4000-8000-000000000020.mp4'
    try {
      await writeFile(video, 'platform-owned-after-trigger-crash')
      await mkdir(inboxRoot, { recursive: true })
      await writeFile(resolve(inboxRoot, videoKey), 'platform-owned-after-trigger-crash')
      await writeFile(fakePlatform, `
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    return json({ runs: [{
      taskId,
      status: 'succeeded',
      input: { videoKey: '${videoKey}' },
      output: { summary: 'done' },
    }] })
  }
  throw new Error('unexpected_platform_request')
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<Record<string, any>>
        writeBatchState: (path: string, state: Record<string, any>) => Promise<Record<string, any>>
      }
      const taskId = `video-natural-${'d'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        trustedExistingMaterialId: 'MATERIAL-EXISTING-020',
        inboxRoot,
        batchRoot: stateRoot,
      })
      const state = await batch.readBatchState(created.statePath)
      const stagedStat = await stat(resolve(inboxRoot, videoKey))
      state.items[0].stagingRecovery = {
        schemaVersion: 1,
        phase: 'triggering',
        sourceIdentity: state.items[0].sourceIdentity,
        anchorName: '.source-anchor-2147483646-00000000-0000-4000-8000-000000000021',
        incomingName: `.incoming-2147483646-${videoKey}`,
        videoKey,
        materialId: 'MATERIAL-EXISTING-020',
        contentSha256: createHash('sha256').update('platform-owned-after-trigger-crash').digest('hex'),
        incomingIdentity: null,
        stagedIdentity: {
          dev: stagedStat.dev,
          ino: stagedStat.ino,
          size: stagedStat.size,
          mtimeMs: stagedStat.mtimeMs,
          ctimeMs: stagedStat.ctimeMs,
        },
        ownershipToken: '00000000-0000-4000-8000-000000000021',
        taskId,
        idempotencyKey: taskId,
        batchId: state.batchId,
      }
      await batch.writeBatchState(created.statePath, state)

      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const recovered = await batch.readBatchState(created.statePath)
      expect(recovered.status).toBe('succeeded')
      expect(recovered.items[0]).not.toHaveProperty('stagingRecovery')
      await expect(access(resolve(inboxRoot, videoKey))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reconciles an active parent periodically and advances the same lane as soon as it fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-reconcile-test-'))
    const videoDir = resolve(root, 'videos')
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const reconcileCount = resolve(root, 'reconcile-count.txt')
    const fakePlatform = resolve(root, 'fake-reconcile-platform.mjs')
    try {
      await mkdir(videoDir)
      await writeFile(resolve(videoDir, '01-active.mp4'), 'active')
      await writeFile(resolve(videoDir, '02-next.mp4'), 'next')
      await writeFile(reconcileCount, '0')
      await writeFile(fakePlatform, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : null
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    return json({ runs: taskId === process.env.FAKE_ACTIVE_TASK_ID
      ? [{ taskId, status: 'running' }]
      : [] })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/runs/reconcile') {
    const count = Number(readFileSync(process.env.FAKE_RECONCILE_COUNT, 'utf8')) + 1
    writeFileSync(process.env.FAKE_RECONCILE_COUNT, String(count))
    appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ action: 'reconcile', taskId: body.taskId }) + '\\n')
    return count < 2
      ? json({ taskId: body.taskId, status: 'running', error: null, reconciled: false, code: null })
      : json({
          taskId: body.taskId,
          status: 'failed',
          error: '视频回调租约已过期',
          reconciled: true,
          code: 'VIDEO_CALLBACK_LEASE_EXPIRED',
        })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ action: 'trigger', taskId: body.taskId }) + '\\n')
    return json({ taskId: body.taskId, status: 'succeeded' })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{
          statePath: string
          state: { items: Array<{ taskId: string }> }
        }>
        readBatchState: (path: string) => Promise<{
          status: string
          items: Array<{ taskId: string; status: string; error: string | null }>
        }>
      }
      const created = await batch.createBatchState({
        batchId: 'reconcile-lane',
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoDir,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const [activeItem, nextItem] = created.state.items
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            AIWORKER_VIDEO_RECONCILE_INTERVAL_MS: '1000',
            FAKE_ACTIVE_TASK_ID: activeItem.taskId,
            FAKE_PLATFORM_LOG: requestLog,
            FAKE_RECONCILE_COUNT: reconcileCount,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const state = await batch.readBatchState(created.statePath)
      expect(state.status).toBe('completed_with_errors')
      expect(state.items).toMatchObject([
        { taskId: activeItem.taskId, status: 'failed', error: '视频回调租约已过期' },
        { taskId: nextItem.taskId, status: 'succeeded', error: null },
      ])
      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(requests).toEqual([
        { action: 'reconcile', taskId: activeItem.taskId },
        { action: 'reconcile', taskId: activeItem.taskId },
        { action: 'trigger', taskId: nextItem.taskId },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('continues from a reconciled orphan batch into the next persisted batch on the same lane', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-cross-batch-reconcile-test-'))
    const firstDir = resolve(root, 'first')
    const secondDir = resolve(root, 'second')
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const fakePlatform = resolve(root, 'fake-cross-batch-platform.mjs')
    try {
      await mkdir(firstDir)
      await mkdir(secondDir)
      await writeFile(resolve(firstDir, '01-orphan.mp4'), 'orphan')
      await writeFile(resolve(secondDir, '01-next.mp4'), 'next')
      await writeFile(fakePlatform, `
import { appendFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : null
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    return json({ runs: taskId === process.env.FAKE_ORPHAN_TASK_ID
      ? [{ taskId, status: 'running' }]
      : [] })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/runs/reconcile') {
    appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ action: 'reconcile', taskId: body.taskId }) + '\\n')
    return json({
      taskId: body.taskId,
      status: 'failed',
      error: '视频回调租约已过期',
      reconciled: true,
      code: 'VIDEO_CALLBACK_LEASE_EXPIRED',
    })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    appendFileSync(process.env.FAKE_PLATFORM_LOG, JSON.stringify({ action: 'trigger', taskId: body.taskId }) + '\\n')
    return json({ taskId: body.taskId, status: 'succeeded' })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{
          statePath: string
          state: { items: Array<{ taskId: string }> }
        }>
        readBatchState: (path: string) => Promise<{
          status: string
          items: Array<{ taskId: string; status: string }>
        }>
      }
      const common = {
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        inboxRoot,
        batchRoot: stateRoot,
      }
      const first = await batch.createBatchState({
        ...common,
        batchId: 'orphan-first',
        videoDir: firstDir,
      })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      const second = await batch.createBatchState({
        ...common,
        batchId: 'queued-second',
        videoDir: secondDir,
      })
      const orphanTask = first.state.items[0]
      const nextTask = second.state.items[0]
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', first.statePath], {
          env: {
            ...process.env,
            AIWORKER_VIDEO_RECONCILE_INTERVAL_MS: '1000',
            FAKE_ORPHAN_TASK_ID: orphanTask.taskId,
            FAKE_PLATFORM_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const firstState = await batch.readBatchState(first.statePath)
      const secondState = await batch.readBatchState(second.statePath)
      expect(firstState).toMatchObject({ status: 'completed_with_errors', items: [{ status: 'failed' }] })
      expect(secondState).toMatchObject({ status: 'succeeded', items: [{ status: 'succeeded' }] })
      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(requests).toEqual([
        { action: 'reconcile', taskId: orphanTask.taskId },
        { action: 'trigger', taskId: nextTask.taskId },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('leaves a paused batch untouched while processing a later queued batch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-paused-skip-test-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const fakePlatform = resolve(root, 'fake-paused-platform.mjs')
    try {
      const pausedDir = resolve(root, 'paused')
      const queuedDir = resolve(root, 'queued')
      await mkdir(pausedDir)
      await mkdir(queuedDir)
      await writeFile(resolve(pausedDir, '01-paused.mp4'), 'paused')
      await writeFile(resolve(queuedDir, '01-queued.mp4'), 'queued')
      await writeFile(fakePlatform, `
import { appendFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  if ((init.method || 'GET') === 'POST') {
    const body = JSON.parse(String(init.body))
    appendFileSync(process.env.FAKE_PLATFORM_LOG, body.taskId + '\\n')
    return json({ taskId: body.taskId, status: 'succeeded' })
  }
  return json({ runs: [] })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{ statePath: string; state: Record<string, unknown> }>
        readBatchState: (path: string) => Promise<{ status: string }>
        writeBatchState: (path: string, state: Record<string, unknown>) => Promise<Record<string, unknown>>
      }
      const common = {
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        inboxRoot,
        batchRoot: stateRoot,
      }
      const paused = await batch.createBatchState({ ...common, batchId: 'paused-first', videoDir: pausedDir })
      await mkdir(inboxRoot, { recursive: true })
      const pausedVideoKey = '00000000-0000-4000-8000-000000000060.mp4'
      const pausedStagedPath = resolve(inboxRoot, pausedVideoKey)
      await writeFile(pausedStagedPath, 'paused')
      const pausedStagedStat = await stat(pausedStagedPath)
      const pausedState = { ...paused.state, status: 'paused', error: 'manual' } as Record<string, any>
      pausedState.items[0].stagingRecovery = {
        schemaVersion: 1,
        phase: 'discarding',
        sourceIdentity: pausedState.items[0].sourceIdentity,
        anchorName: '.source-anchor-2147483646-00000000-0000-4000-8000-000000000061',
        incomingName: `.incoming-2147483646-${pausedVideoKey}`,
        videoKey: pausedVideoKey,
        materialId: 'MATERIAL-PAUSED-CLEANUP',
        contentSha256: createHash('sha256').update('paused').digest('hex'),
        incomingIdentity: null,
        stagedIdentity: {
          dev: pausedStagedStat.dev,
          ino: pausedStagedStat.ino,
          size: pausedStagedStat.size,
          mtimeMs: pausedStagedStat.mtimeMs,
          ctimeMs: pausedStagedStat.ctimeMs,
        },
        ownershipToken: '00000000-0000-4000-8000-000000000061',
        taskId: pausedState.items[0].taskId,
        idempotencyKey: pausedState.items[0].idempotencyKey,
        batchId: pausedState.batchId,
      }
      await batch.writeBatchState(paused.statePath, pausedState)
      const queued = await batch.createBatchState({ ...common, batchId: 'queued-second', videoDir: queuedDir })
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', queued.statePath], {
          env: {
            ...process.env,
            FAKE_PLATFORM_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })
      const reconciledPaused = await batch.readBatchState(paused.statePath) as Record<string, any>
      expect(reconciledPaused.status).toBe('paused')
      expect(reconciledPaused.items[0]).not.toHaveProperty('stagingRecovery')
      await expect(access(pausedStagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await batch.readBatchState(queued.statePath)).status).toBe('succeeded')
      expect(await readFile(requestLog, 'utf8')).toContain('queued-second:video:001:')
      expect(await readFile(requestLog, 'utf8')).not.toContain('paused-first:video:001:')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drains concurrent batch workers through one global queue without replaying terminal items', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-video-worker-queue-test-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.jsonl')
    const runState = resolve(root, 'runs.json')
    const fakePlatform = resolve(root, 'fake-batch-platform.mjs')
    try {
      const firstDir = resolve(root, 'first')
      const secondDir = resolve(root, 'second')
      await mkdir(firstDir)
      await mkdir(secondDir)
      await writeFile(resolve(firstDir, '01-first.mp4'), 'first')
      await writeFile(resolve(secondDir, '01-second.mp4'), 'second')
      await writeFile(runState, '{}')
      await writeFile(fakePlatform, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const runs = JSON.parse(readFileSync(process.env.FAKE_RUN_STATE, 'utf8'))
  if ((init.method || 'GET') === 'POST' && url.pathname === '/api/n8n/trigger') {
    const body = JSON.parse(String(init.body))
    appendFileSync(process.env.FAKE_PLATFORM_LOG, body.taskId + '\\n')
    runs[body.taskId] = { polls: 0 }
    writeFileSync(process.env.FAKE_RUN_STATE, JSON.stringify(runs))
    return json({ taskId: body.taskId, status: 'accepted' })
  }
  if (url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    const run = runs[taskId]
    if (!run) return json({ runs: [] })
    run.polls += 1
    writeFileSync(process.env.FAKE_RUN_STATE, JSON.stringify(runs))
    return json({ runs: [{ taskId, status: 'succeeded', output: { ok: true } }] })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<{ status: string; items: Array<{ status: string }> }>
      }
      const common = {
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        inboxRoot,
        batchRoot: stateRoot,
      }
      const first = await batch.createBatchState({ ...common, batchId: 'queue-first', videoDir: firstDir })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      const second = await batch.createBatchState({ ...common, batchId: 'queue-second', videoDir: secondDir })
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      const env = {
        ...process.env,
        FAKE_PLATFORM_LOG: requestLog,
        FAKE_RUN_STATE: runState,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
          .filter(Boolean).join(' '),
      }
      const runWorker = (statePath: string) => new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', statePath], { env }, (error, _stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise()
        })
      })
      await Promise.all([runWorker(first.statePath), runWorker(second.statePath)])
      const firstState = await batch.readBatchState(first.statePath)
      const secondState = await batch.readBatchState(second.statePath)
      expect(firstState.status).toBe('succeeded')
      expect(secondState.status).toBe('succeeded')
      expect(firstState.items.map(item => item.status)).toEqual(['succeeded'])
      expect(secondState.items.map(item => item.status)).toEqual(['succeeded'])
      const firstLog = (await readFile(requestLog, 'utf8')).trim().split('\n')
      expect(firstLog).toHaveLength(2)
      expect(firstLog[0]).toContain('queue-first:video:001:')
      expect(firstLog[1]).toContain('queue-second:video:001:')

      await runWorker(second.statePath)
      expect((await readFile(requestLog, 'utf8')).trim().split('\n')).toEqual(firstLog)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('finishes journal-bound discarding before accepting an existing platform record', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-discard-existing-run-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const fakePlatform = resolve(root, 'fake-discard-existing-platform.mjs')
    const video = resolve(root, 'discard-existing.mp4')
    const videoKey = '00000000-0000-4000-8000-000000000030.mp4'
    try {
      const content = 'discard-existing-media'
      await writeFile(video, content)
      await mkdir(inboxRoot, { recursive: true })
      const stagedPath = resolve(inboxRoot, videoKey)
      await writeFile(stagedPath, content)
      await writeFile(fakePlatform, `
const json = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async input => {
  const url = new URL(String(input))
  const taskId = url.searchParams.get('taskId')
  if (url.pathname === '/api/n8n/runs') return json({ runs: [{
    taskId,
    status: 'succeeded',
    input: { videoKey: '00000000-0000-4000-8000-000000000099.mp4' },
  }] })
  throw new Error('unexpected_platform_request')
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<Record<string, any>>
        writeBatchState: (path: string, state: Record<string, any>) => Promise<Record<string, any>>
      }
      const taskId = `video-natural-${'e'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const state = await batch.readBatchState(created.statePath)
      const stagedStat = await stat(stagedPath)
      state.status = 'recovering'
      state.items[0].status = 'running'
      state.items[0].stagingRecovery = {
        schemaVersion: 1,
        phase: 'discarding',
        sourceIdentity: state.items[0].sourceIdentity,
        anchorName: '.source-anchor-2147483646-00000000-0000-4000-8000-000000000031',
        incomingName: `.incoming-2147483646-${videoKey}`,
        videoKey,
        materialId: 'MATERIAL-EXISTING-030',
        contentSha256: createHash('sha256').update(content).digest('hex'),
        incomingIdentity: null,
        stagedIdentity: {
          dev: stagedStat.dev,
          ino: stagedStat.ino,
          size: stagedStat.size,
          mtimeMs: stagedStat.mtimeMs,
          ctimeMs: stagedStat.ctimeMs,
        },
        ownershipToken: '00000000-0000-4000-8000-000000000031',
        taskId,
        idempotencyKey: taskId,
        batchId: state.batchId,
      }
      await batch.writeBatchState(created.statePath, state)

      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })
      const recovered = await batch.readBatchState(created.statePath)
      expect(recovered.status).toBe('succeeded')
      expect(recovered.items[0]).not.toHaveProperty('stagingRecovery')
      await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quarantines an unverifiable item without blocking later items in the same batch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-unknown-video-key-attention-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const requestLog = resolve(root, 'requests.log')
    const fakePlatform = resolve(root, 'fake-unknown-video-key-platform.mjs')
    const videoDir = resolve(root, 'videos')
    const stagedVideoKey = '00000000-0000-4000-8000-000000000071.mp4'
    try {
      await mkdir(videoDir)
      await writeFile(resolve(videoDir, '01-first.mp4'), 'unknown-key-media')
      await writeFile(resolve(videoDir, '02-second.mp4'), 'next-batch-media')
      await mkdir(inboxRoot, { recursive: true })
      const stagedPath = resolve(inboxRoot, stagedVideoKey)
      await writeFile(stagedPath, 'unknown-key-media')
      await writeFile(fakePlatform, `
import { appendFileSync } from 'node:fs'
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  if (method === 'GET' && url.pathname === '/api/n8n/runs') {
    const taskId = url.searchParams.get('taskId')
    return json({ runs: taskId === process.env.FAKE_ATTENTION_TASK_ID
      ? [{ taskId, status: 'running', input: {} }]
      : [] })
  }
  if (method === 'POST' && url.pathname === '/api/n8n/trigger') {
    const body = JSON.parse(String(init.body))
    appendFileSync(process.env.FAKE_PLATFORM_LOG, body.taskId + '\\n')
    return json({ taskId: body.taskId, status: 'succeeded' })
  }
  return json({ error: 'unexpected request' })
}
`)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createBatchState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<Record<string, any>>
        writeBatchState: (path: string, state: Record<string, any>) => Promise<Record<string, any>>
      }
      const common = {
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        inboxRoot,
        batchRoot: stateRoot,
      }
      const created = await batch.createBatchState({
        ...common,
        batchId: 'attention-same-batch',
        videoDir,
      })
      const firstState = await batch.readBatchState(created.statePath)
      const firstTaskId = firstState.items[0].taskId
      const stagedStat = await stat(stagedPath)
      firstState.status = 'recovering'
      firstState.items[0].status = 'running'
      firstState.items[0].stagingRecovery = {
        schemaVersion: 1,
        phase: 'triggering',
        sourceIdentity: firstState.items[0].sourceIdentity,
        anchorName: '.source-anchor-2147483646-00000000-0000-4000-8000-000000000072',
        incomingName: `.incoming-2147483646-${stagedVideoKey}`,
        videoKey: stagedVideoKey,
        materialId: 'MATERIAL-UNKNOWN-VIDEO-KEY',
        contentSha256: createHash('sha256').update('unknown-key-media').digest('hex'),
        incomingIdentity: null,
        stagedIdentity: {
          dev: stagedStat.dev,
          ino: stagedStat.ino,
          size: stagedStat.size,
          mtimeMs: stagedStat.mtimeMs,
          ctimeMs: stagedStat.ctimeMs,
        },
        ownershipToken: '00000000-0000-4000-8000-000000000072',
        taskId: firstTaskId,
        idempotencyKey: firstTaskId,
        batchId: firstState.batchId,
      }
      await batch.writeBatchState(created.statePath, firstState)
      const secondTaskId = firstState.items[1].taskId
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            FAKE_ATTENTION_TASK_ID: firstTaskId,
            FAKE_PLATFORM_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })

      const quarantined = await batch.readBatchState(created.statePath)
      expect(quarantined.status).toBe('completed_with_errors')
      expect(quarantined.items[0].status).toBe('attention')
      expect(quarantined.items[0].stagingRecovery.phase).toBe('triggering')
      expect(await readFile(stagedPath, 'utf8')).toBe('unknown-key-media')
      expect(quarantined.items[1].status).toBe('succeeded')
      const attentionJournal = structuredClone(quarantined.items[0].stagingRecovery)
      const firstRequests = (await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean)
      expect(firstRequests).toEqual([secondTaskId])

      // An explicit recovery invocation must keep the quarantined ownership
      // journal untouched and must not replay either the attention item or a
      // later item that already succeeded in this same batch.
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], {
          env: {
            ...process.env,
            FAKE_ATTENTION_TASK_ID: firstTaskId,
            FAKE_PLATFORM_LOG: requestLog,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fakePlatform).href}`]
              .filter(Boolean).join(' '),
          },
        }, (error, _stdout, stderr) => error
          ? rejectPromise(new Error(stderr || error.message))
          : resolvePromise())
      })
      const recoveredAgain = await batch.readBatchState(created.statePath)
      expect(recoveredAgain.status).toBe('completed_with_errors')
      expect(recoveredAgain.items[0].status).toBe('attention')
      expect(recoveredAgain.items[0].stagingRecovery).toEqual(attentionJournal)
      expect(recoveredAgain.items[1].status).toBe('succeeded')
      expect(await readFile(stagedPath, 'utf8')).toBe('unknown-key-media')
      expect((await readFile(requestLog, 'utf8')).trim().split('\n').filter(Boolean)).toEqual(firstRequests)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries terminal-item journal cleanup instead of permanently skipping it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'aiworker-terminal-cleanup-retry-'))
    const stateRoot = resolve(root, 'state')
    const inboxRoot = resolve(root, 'inbox')
    const video = resolve(root, 'terminal-cleanup.mp4')
    const videoKey = '00000000-0000-4000-8000-000000000040.mp4'
    try {
      const content = 'terminal-cleanup-media'
      await writeFile(video, content)
      await mkdir(inboxRoot, { recursive: true })
      const stagedPath = resolve(inboxRoot, videoKey)
      await writeFile(stagedPath, content)
      const moduleUrl = pathToFileURL(resolve(
        process.cwd(),
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      const batch = await import(/* @vite-ignore */ moduleUrl) as {
        createSingleVideoState: (input: Record<string, unknown>) => Promise<{ statePath: string }>
        readBatchState: (path: string) => Promise<Record<string, any>>
        writeBatchState: (path: string, state: Record<string, any>) => Promise<Record<string, any>>
      }
      const taskId = `video-natural-${'f'.repeat(64)}`
      const created = await batch.createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl: 'http://127.0.0.1:3017',
        bindingId: 'video-binding',
        prompt: '分析视频',
        visionRoute: null,
        videoFile: video,
        inboxRoot,
        batchRoot: stateRoot,
      })
      const state = await batch.readBatchState(created.statePath)
      const stagedStat = await stat(stagedPath)
      state.status = 'succeeded'
      state.items[0].status = 'succeeded'
      state.items[0].completedAt = new Date().toISOString()
      state.items[0].stagingRecovery = {
        schemaVersion: 1,
        phase: 'discarding',
        sourceIdentity: state.items[0].sourceIdentity,
        anchorName: '.source-anchor-2147483646-00000000-0000-4000-8000-000000000041',
        incomingName: `.incoming-2147483646-${videoKey}`,
        videoKey,
        materialId: 'MATERIAL-TERMINAL-CLEANUP',
        contentSha256: createHash('sha256').update(content).digest('hex'),
        incomingIdentity: null,
        stagedIdentity: {
          dev: stagedStat.dev,
          ino: stagedStat.ino,
          size: stagedStat.size,
          mtimeMs: stagedStat.mtimeMs,
          ctimeMs: stagedStat.ctimeMs,
        },
        ownershipToken: '00000000-0000-4000-8000-000000000041',
        taskId,
        idempotencyKey: taskId,
        batchId: state.batchId,
      }
      await batch.writeBatchState(created.statePath, state)
      const claimPath = resolve(inboxRoot, '.cleanup-claim-00000000-0000-4000-8000-000000000041-final')
      await writeFile(claimPath, 'conflicting-claim')
      const worker = resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs')
      const runWorker = () => new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(process.execPath, [worker, '--state-file', created.statePath], (error, _stdout, stderr) => {
          if (error) return rejectPromise(new Error(stderr || error.message))
          resolvePromise()
        })
      })

      await runWorker()
      const failedCleanup = await batch.readBatchState(created.statePath)
      expect(failedCleanup.status).toBe('recovering')
      expect(failedCleanup.items[0].status).toBe('succeeded')
      expect(failedCleanup.items[0].stagingRecovery.phase).toBe('discarding')

      await rm(claimPath)
      await runWorker()
      const recovered = await batch.readBatchState(created.statePath)
      expect(recovered.status).toBe('succeeded')
      expect(recovered.items[0]).not.toHaveProperty('stagingRecovery')
      await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
