#!/usr/bin/env node

import { runDirectorBrainCli } from './lib/feishu-director-brain.mjs'

try {
  const result = await runDirectorBrainCli(process.argv.slice(2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(JSON.stringify({
    ok: false,
    error: message.slice(0, 1_000),
  }) + '\n')
  process.exitCode = 1
}
