import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SCRIPT_PATH = resolve(
  process.cwd(),
  'scripts/upgrade-aiworker-video-command-task-chain-tool.sh',
)
const RESULT_SCRIPT_PATH = resolve(
  process.cwd(),
  'scripts/upgrade-aiworker-video-command-result-plugin.sh',
)

describe('task-chain tool upgrade script', () => {
  it('checks protected listener readiness without pinning a restarted Gateway PID', async () => {
    const script = await readFile(SCRIPT_PATH, 'utf8')

    expect(script).toContain("printf '%s=ready\\n' \"$port\"")
    expect(script).toContain('lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1')
    expect(script).not.toContain("tr '\\n' ','")
    expect(script).not.toContain("printf '%s=%s\\n' \"$port\" \"$pids\"")
  })

  it('ignores unverified recovery directories during backup retention', async () => {
    const script = await readFile(SCRIPT_PATH, 'utf8')

    expect(script).toContain("const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')")
    expect(script).toContain("existsSync(join(entry.path, '.verified'))")
  })

  it('keeps the final-report refresh as an explicit 0.5.4 to 0.5.5 upgrade family', async () => {
    const script = await readFile(RESULT_SCRIPT_PATH, 'utf8')

    expect(script).toContain('PREVIOUS_VERSION="0.5.4"')
    expect(script).toContain('CANDIDATE_VERSION="0.5.5"')
    expect(script).toContain('result-plugin-upgrade-')
    expect(script).toContain('No plugin, config, gateway, queue, n8n, media, or database state changed.')
  })
})
