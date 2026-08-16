import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SCRIPT_PATH = resolve(
  process.cwd(),
  'scripts/upgrade-aiworker-video-command-task-chain-tool.sh',
)

describe('task-chain tool upgrade script', () => {
  it('checks protected listener readiness without pinning a restarted Gateway PID', async () => {
    const script = await readFile(SCRIPT_PATH, 'utf8')

    expect(script).toContain("printf '%s=ready\\n' \"$port\"")
    expect(script).toContain('lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1')
    expect(script).not.toContain("tr '\\n' ','")
    expect(script).not.toContain("printf '%s=%s\\n' \"$port\" \"$pids\"")
  })
})
