#!/usr/bin/env node

import './check-node-version.mjs'
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Keep the verified Node process as the parent on macOS. The canonical shell
// controller still owns every source check, deployment lock and state change.
const child = spawn('/bin/bash', [
  resolve(repositoryRoot, 'scripts/deploy-blue-green.sh'),
  ...process.argv.slice(2),
], {
  cwd: repositoryRoot,
  env: { ...process.env, NODE_BIN: process.execPath },
  stdio: 'inherit',
})

const forwarders = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
  const forward = () => child.kill(signal)
  process.on(signal, forward)
  return [signal, forward]
}))

child.once('error', error => {
  console.error(`Unable to start blue-green controller: ${error.message}`)
})
child.once('close', (code, signal) => {
  for (const [name, forward] of forwarders) process.off(name, forward)
  process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)
})
