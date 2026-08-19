import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('OpenClaw task-flow submit script', () => {
  it('routes explicit video arguments once and rejects video-shaped generic prompts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'openclaw-video-command-test-'))
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
        AIWORKER_VIDEO_BATCH_DIR: resolve(root, 'batch-state'),
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
    const installer = resolve(process.cwd(), 'scripts/install-aiworker-task-flow-skill.sh')
    const runInstaller = (backupRoot: string) => new Promise<void>((resolvePromise, rejectPromise) => {
      execFile('bash', [installer, '--apply'], {
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
    expect(worker).toContain("if (batchTerminal(state.status) || !recoveryRunnable(state.status)) continue")
  })

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
      await batch.writeBatchState(paused.statePath, { ...paused.state, status: 'paused', error: 'manual' })
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
      expect((await batch.readBatchState(paused.statePath)).status).toBe('paused')
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
})
