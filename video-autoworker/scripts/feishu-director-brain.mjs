#!/usr/bin/env node

import {
  directorBrainStdinSpec,
  runDirectorBrainCli,
} from './lib/feishu-director-brain.mjs'

async function readStdin({ label, maximumBytes }) {
  const chunks = []
  let totalBytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > maximumBytes) {
      process.stdin.pause()
      process.stdin.destroy()
      throw new Error(label + '_stdin_too_large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

try {
  const argv = process.argv.slice(2)
  const stdinSpec = directorBrainStdinSpec(argv[0])
  const result = await runDirectorBrainCli(argv, {
    ...(stdinSpec ? { stdin: await readStdin(stdinSpec) } : {}),
  })
  process.stdout.write(JSON.stringify(result, null, stdinSpec ? 0 : 2) + '\n')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(JSON.stringify({
    ok: false,
    error: message.slice(0, 1_000),
  }) + '\n')
  process.exitCode = 1
}
