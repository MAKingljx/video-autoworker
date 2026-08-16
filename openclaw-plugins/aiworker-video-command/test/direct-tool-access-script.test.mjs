import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const script = resolve(process.cwd(), 'scripts/enable-aiworker-video-command-direct-tool.sh')

describe('direct tool access deployment gate', () => {
  it('limits the permission change to second-original tools.alsoAllow', async () => {
    const source = await readFile(script, 'utf8')
    expect(source).toContain('agent.tools.alsoAllow = [toolId]')
    expect(source).toContain('validate_effective present')
    expect(source).toContain('validate_effective absent')
    expect(source).toContain('validate_pre_access_config')
    expect(source).not.toContain('tools.allow.push')
  })

  it('uses listener readiness rather than a Gateway PID invariant', async () => {
    const source = await readFile(script, 'utf8')
    expect(source).toContain('lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1')
    expect(source).not.toContain("printf '%s=%s\\n' \"$port\" \"$pids\"")
  })
})
