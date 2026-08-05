import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

function runScript(args: string[]) {
  const script = resolve(process.cwd(), 'scripts/sync-model-resources.mjs')
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    execFile(process.execPath, [script, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

describe('model resource sync script', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiworker-model-sync-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('preserves route configuration while enabling the video vision capability', async () => {
    const templatePath = join(root, 'template.json')
    const targetPath = join(root, 'target.json')
    const template = {
      version: 1,
      routes: [{
        id: 'local-qwen36-direct',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:18091/v1',
        model: 'default_model',
        capabilities: ['text', 'vision'],
      }],
      resources: [{
        id: 'whisper-large-v3-turbo',
        kind: 'speech-recognition',
        usedBy: ['视频分析任务链 / 音频分析节点'],
      }],
    }
    const target = {
      version: 1,
      routes: [
        {
          id: 'local-qwen36-direct',
          transport: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:19000/v1',
          model: 'production-model',
          capabilities: ['text'],
          custom: 'preserve-me',
        },
        { id: 'custom-cloud', transport: 'openai-compatible', capabilities: ['text'] },
      ],
      resources: [
        { id: 'whisper-large-v3-turbo', usedBy: ['old'] },
        { id: 'custom-resource', usedBy: ['custom'] },
      ],
    }
    await writeFile(templatePath, JSON.stringify(template), { mode: 0o600 })
    await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 })
    await chmod(targetPath, 0o600)

    const result = await runScript([templatePath, targetPath, '--enable-video-analysis'])
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('启用视频分析视觉直连能力')

    const updated = JSON.parse(await readFile(targetPath, 'utf8'))
    expect(updated.routes[0]).toMatchObject({
      id: 'local-qwen36-direct',
      baseUrl: 'http://127.0.0.1:19000/v1',
      model: 'production-model',
      custom: 'preserve-me',
      capabilities: ['text', 'vision'],
    })
    expect(updated.routes[1]).toEqual(target.routes[1])
    expect(updated.resources.map((item: { id: string }) => item.id)).toEqual([
      'custom-resource',
      'whisper-large-v3-turbo',
    ])
    const backups = (await readdir(root)).filter(name => name.startsWith('target.json.backup-'))
    expect(backups).toHaveLength(1)
    expect((await stat(join(root, backups[0]))).mode & 0o777).toBe(0o600)
  })
})
