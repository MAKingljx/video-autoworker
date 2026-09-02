import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

describe('OpenClaw-only production launch contract', () => {
  const temporary: string[] = []

  afterEach(() => {
    for (const pathname of temporary.splice(0)) rmSync(pathname, { recursive: true, force: true })
  })

  it.each([
    'scripts/deploy-standalone.sh',
    'scripts/start-standalone.sh',
    'scripts/start-standalone-slot.sh',
  ])('%s fixes production auth and listener to the loopback channel', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    expect(source).toContain('openclaw-loopback')
    expect(source).toContain('MC_DESKTOP_MODE="0"')
    expect(source).toContain('127.0.0.1')
    expect(source).toMatch(/MC_HOSTNAME must remain 127\.0\.0\.1/u)
  })

  it('removes every whitespace/export spelling of the retired webhook secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-env-auth-'))
    temporary.push(root)
    const environmentPath = join(root, 'platform.env')
    writeFileSync(environmentPath, [
      'KEEP_VALUE=yes',
      'N8N_WEBHOOK_SECRET=one',
      '  N8N_WEBHOOK_SECRET = two',
      '\texport N8N_WEBHOOK_SECRET=three',
      'export\tN8N_WEBHOOK_SECRET = four',
      '',
    ].join('\n'), { mode: 0o600 })

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/install-platform-env.sh')], {
      encoding: 'utf8',
      env: { ...process.env, AIWORKER_PLATFORM_ENV_FILE: environmentPath },
    })
    expect(result.status, result.stderr).toBe(0)
    const output = readFileSync(environmentPath, 'utf8')
    expect(output).toContain('KEEP_VALUE=yes')
    expect(output).not.toMatch(/N8N_WEBHOOK_SECRET/u)
  })
})
