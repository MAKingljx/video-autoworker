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
    return json({ runs: [{
      taskId: url.searchParams.get('taskId'),
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 1,
      output: { summary: '状态客户端测试摘要' },
      updatedAt: '2026-08-11T12:00:00.000Z',
    }] })
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
          '--video-file', videoPath,
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
      expect(noRecoveryRun.failed).toBe(true)
      expect(noRecoveryRun.exitCode).toBe(75)
      expect(noRecoveryRun.stdout).toBe('')
      expect(noRecoveryRun.stderr).toBe('video_trigger_unconfirmed\n')

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
      expect(triggerRequests[0]?.body).toMatchObject({
        bindingId: 'video-binding',
        taskId: 'explicit-video-task',
        idempotencyKey: 'explicit-video-task',
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
      expect(triggerRequests.filter(request => request.body?.taskId === 'explicit-video-task')).toHaveLength(1)
      expect(requests.filter(({ method, url }) => (
        method === 'GET' && url === '/api/n8n/runs?taskId=explicit-video-task'
      ))).toHaveLength(1)
      const noRecoveryRequests = requests.filter(request => (
        request.body?.taskId === 'no-recovery-task'
        || request.url.includes('taskId=no-recovery-task')
      ))
      expect(noRecoveryRequests.filter(({ method, url }) => (
        method === 'POST' && url === '/api/n8n/trigger'
      ))).toHaveLength(1)
      expect(noRecoveryRequests.some(({ method, url }) => (
        method === 'GET' && url.startsWith('/api/n8n/runs?')
      ))).toBe(false)
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

    expect(skill).toContain('Reuse one stable task/idempotency key')
    expect(skill).toContain('--task-id <stable-request-key>')
    expect(skill).toContain('--idempotency-key <stable-request-key>')
    expect(skill).toContain('--task-id <stable-key>')
    expect(skill).toContain('--idempotency-key <stable-key>')
    expect(skill).toContain('A batch ID is not a task ID')
    expect(skill).toContain('--batch-status <stable-batch-key>')
  })

  it('defines both single-video conversation forms as native asynchronous entries', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    expect(skill).toContain('分析视频 /完整路径/video.mp4')
    expect(skill).toContain('帮我分析一下这个视频 /完整路径/video.mp4')
    expect(skill).toContain('`分析视频 <绝对路径>`')
    expect(skill).toContain('--video-file "<absolute-video-path>"')
    expect(skill).toContain('--task-id <stable-request-key>')
    expect(skill).toContain('--idempotency-key <stable-request-key>')
    expect(skill).toContain('--delivery none')
    expect(skill).toContain('--wait-seconds 0')
    expect(skill).toContain('--no-trigger-recovery')
    expect(workspaceRules).toContain('`分析视频 <绝对路径>`')
    expect(workspaceRules).toContain('`帮我分析一下这个视频 <绝对路径>`')
    expect(skill).toContain("plugin's `before_dispatch` hook")
    expect(workspaceRules).toContain('in `before_dispatch`, before')
    const stableEntry = 'node "$HOME/AI-worker-second-original-workspace/skills/aiworker-task-flow/scripts/submit-task.mjs"'
    expect(skill).toContain(stableEntry)
    expect(skill).toContain('implementation reference, not an')
    expect(workspaceRules).toContain('Do not ask Qwen to choose a video tool')
  })

  it('contracts native single-video dispatch to one silent submission and one receipt', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules]) {
      expect(contract).toContain('shared runner')
      expect(contract).toMatch(/exactly\s+once/u)
      expect(contract).toMatch(/Do not narrate|Do not\s+narrate/u)
      expect(contract).toMatch(/generic prompt|generic task/u)
      expect(contract).toMatch(/same turn/u)
      expect(contract).toMatch(/later explicit user request/u)
      expect(contract).toContain('`delivery=none`')
      expect(contract).toContain('`memoryMode=none`')
    }
    expect(skill).toContain('After any receipt, rejection, or failure, stop the turn')
    expect(skill).toContain('已提交，任务编号：<taskId>。结果请稍后查询。')
    expect(skill).toContain('任务已存在，任务编号：<taskId>。结果请稍后查询。')
    expect(skill).toContain('提交状态暂未确认，任务编号：<taskId>。请稍后查询。')
    expect(workspaceRules).toContain('return only')
    expect(workspaceRules).toContain('`--wait-seconds 0`')
    expect(workspaceRules).toContain('`--no-trigger-recovery`')
  })

  it('answers video-chain explanation questions without tools or retired routes', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    const fixedReply = '视频会由原生插件一次派发到 AI-worker，后台依次执行 prepare、Whisper 音频、本地 Qwen 画面和 finalize；当前轮不等待，结果按任务编号另查。'

    expect([...fixedReply].length).toBeLessThanOrEqual(120)
    for (const contract of [skill, workspaceRules]) {
      expect(contract).toContain(fixedReply)
      expect(contract).toMatch(/does not return the completed|never automatically returns the completed/u)
      expect(contract).toMatch(/local Qwen vision/)
      expect(contract).toContain('`video-learning-pipeline`')
    }
    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toMatch(/zero\s+tools/i)
      expect(contract).toMatch(/memory_search|memory lookup/u)
      expect(contract).toMatch(/generic task/u)
      expect(contract).toMatch(/later explicit\s+status\s+request/u)
    }
  })

  it('routes affirmative natural-language video execution through native before_dispatch', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    const description = skill.match(/^description: (.+)$/m)?.[1]

    expect(description?.length).toBeLessThanOrEqual(160)
    for (const contract of [workspaceRules, workspaceMemory]) {
      expect(contract).toContain('`before_dispatch`')
      expect(contract).toMatch(/exact|精确/u)
      expect(contract).toMatch(/affirmative\s+natural-language|肯定自然语言/u)
      expect(contract).toMatch(/generic prompt|generic task/u)
      expect(contract).not.toContain('`aiworker_analyze_video`')
      expect(contract).not.toContain('`tools.allow`')
      expect(contract).not.toContain('`tools.profile`')
    }
    expect(workspaceRules).toContain('fail closed')
    expect(workspaceMemory).toContain('local target contract')
  })

  it('keeps later human status lookup separate and bounded to the latest receipt', () => {
    const skill = readFileSync(resolve(process.cwd(), 'openclaw-skills/aiworker-task-flow/SKILL.md'), 'utf8')
    const workspaceRules = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md',
    ), 'utf8')
    const workspaceMemory = readFileSync(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md',
    ), 'utf8')
    const architecture = readFileSync(resolve(
      process.cwd(),
      'docs/architecture/openclaw-video-analysis-flow.md',
    ), 'utf8')

    for (const contract of [skill, workspaceRules, workspaceMemory]) {
      expect(contract).toContain('`before_dispatch`')
      expect(contract).toMatch(/trusted[\s\S]{0,100}most-recent receipt|trusted unique most-recent receipt/u)
      expect(contract).toMatch(/complete task ID/u)
      expect(contract).toMatch(/exactly once/u)
      expect(contract).toMatch(/read-only\s+status/u)
      expect(contract).toMatch(/Qwen/u)
      expect(contract).toContain('`memory_search`')
      expect(contract).toMatch(/filesystem|file/u)
      expect(contract).toMatch(/SQLite/u)
      expect(contract).toMatch(/polling/u)
      expect(contract).toMatch(/resubmission|resubmit/u)
    }
    expect(skill).toContain('请提供完整任务编号。')
    expect(workspaceRules).toContain('请提供完整任务编号。')
    for (const reply of [
      '任务已受理，正在等待处理。',
      '任务正在处理中。',
      '任务已完成。',
      '任务处理失败。',
      '暂时无法查询任务状态。',
    ]) {
      expect(skill).toContain(reply)
      expect(workspaceRules).toContain(reply)
    }
    expect(architecture).toContain('before_dispatch 状态分类')
    expect(architecture).toContain('只读状态 runner 查询一次')
    expect(architecture).toContain('禁止启动 Qwen')
    expect(architecture).toContain('不产生新提交')
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
