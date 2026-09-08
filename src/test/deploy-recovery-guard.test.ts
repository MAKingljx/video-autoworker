// @vitest-environment node

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
const roots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function shellFunction(name: string, next: string): string {
  const start = deploySource.indexOf(`${name}() {`)
  const end = deploySource.indexOf(`\n}\n\n${next}() {`, start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return deploySource.slice(start, end + 2)
}

describe('blue-green recovery guard contracts', () => {
  it.each([
    ['dual', 0],
    ['dual-recovery', 0],
    ['recovery-hold', 1],
    ['unknown', 2],
  ])('classifies %s handoff without revoking an existing recovery hold', (mode, expected) => {
    const source = `set -euo pipefail
${shellFunction('guard_mode_requires_handoff', 'guard_status_bounded')}
status=0
guard_mode_requires_handoff "$1" || status=$?
exit "$status"
`
    const result = spawnSync('/bin/bash', ['-c', source, 'guard-mode-test', mode], {
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(expected)
  })

  it('routes only dual modes through the existing handoff command', () => {
    expect(deploySource).toContain('if guard_mode_requires_handoff "$guard_mode"; then')
    expect(deploySource).toContain('guard_controller" handoff')
    expect(deploySource).toContain('(( guard_mode_status == 1 ))')
    expect(deploySource).not.toContain('if [[ "$guard_mode" == dual ]]; then')
  })

  it('initializes attested status before the existing recovery-hold path reads it', () => {
    const bootstrap = deploySource.slice(
      deploySource.indexOf('bootstrap_baseline() {'),
      deploySource.indexOf('\nbind_slot() {'),
    )
    const initialization = bootstrap.indexOf('guard_status=""')
    const existingGuardRead = bootstrap.indexOf('if [[ -z "$guard_status" ]]')
    expect(initialization).toBeGreaterThan(0)
    expect(existingGuardRead).toBeGreaterThan(initialization)
  })

  it('bounds each guard status subprocess independently', () => {
    const root = mkdtempSync(`${tmpdir()}/video-autoworker-guard-status-`)
    roots.push(root)
    const controller = `${root}/controller.mjs`
    writeFileSync(controller, 'setTimeout(() => {}, 5000)\n', { mode: 0o700 })
    chmodSync(controller, 0o700)
    const source = `set -euo pipefail
NODE_BIN="$1"
GUARD_STATUS_TIMEOUT_MS=1000
${shellFunction('guard_status_bounded', 'wait_for_recovery_guard_ready')}
guard_status_bounded 100 "$2" /tmp/socket /tmp/mission /tmp/n8n
`
    const started = Date.now()
    const result = spawnSync('/bin/bash', [
      '-c', source, 'guard-status-test', process.execPath, controller,
    ], { encoding: 'utf8', timeout: 2000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(124)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('waits for the explicit ready signal and returns attested status within one deadline', async () => {
    const root = mkdtempSync(`${tmpdir()}/video-autoworker-guard-ready-`)
    roots.push(root)
    const socket = `${root}/guard.sock`
    const token = `${root}/guard.token`
    const log = `${root}/guard.log`
    writeFileSync(token, '{}\n', { mode: 0o600 })
    writeFileSync(log, '', { mode: 0o600 })
    const server = createServer()
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socket, resolvePromise)
    })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    })
    children.push(child)
    const source = `set -euo pipefail
BOOTSTRAP_RECOVERY_GUARD_READY_SECONDS=3
GUARD_STATUS_TIMEOUT_MS=1000
guard_status_bounded() { printf '%s\\n' '{"mode":"dual-recovery","ready":true}'; }
${shellFunction('wait_for_recovery_guard_ready', 'verify_deployment_source_gate')}
READY_PID="$1"
READY_LOG="$5"
sleep() {
  [[ "$1" == 1 ]] || return 2
  printf 'Legacy freeze guard active: pid=%s\\n' "$READY_PID" >> "$READY_LOG"
}
wait_for_recovery_guard_ready "$1" /controller "$2" "$3" /mission /n8n "$5"
`
    const result = spawnSync('/bin/bash', [
      '-c', source, 'guard-ready-test', String(child.pid), socket, token, root, log,
    ], { encoding: 'utf8', timeout: 5000 })
    server.close()
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dual-recovery', ready: true })
  })

  it('fails when the recovery guard dies or consumes its single ready deadline', () => {
    const root = mkdtempSync(`${tmpdir()}/video-autoworker-guard-deadline-`)
    roots.push(root)
    const log = `${root}/guard.log`
    writeFileSync(log, '', { mode: 0o600 })
    const source = `set -euo pipefail
BOOTSTRAP_RECOVERY_GUARD_READY_SECONDS=1
GUARD_STATUS_TIMEOUT_MS=1000
guard_status_bounded() { return 1; }
${shellFunction('wait_for_recovery_guard_ready', 'verify_deployment_source_gate')}
wait_for_recovery_guard_ready "$1" /controller "$2" "$3" /mission /n8n "$4"
`
    const dead = spawnSync('/bin/bash', [
      '-c', source, 'guard-dead-test', '99999999', `${root}/socket`, `${root}/token`, log,
    ], { encoding: 'utf8', timeout: 2000 })
    expect(dead.status).toBe(1)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    })
    children.push(child)
    const started = Date.now()
    const expired = spawnSync('/bin/bash', [
      '-c', source, 'guard-deadline-test', String(child.pid), `${root}/socket`, `${root}/token`, log,
    ], { encoding: 'utf8', timeout: 3000 })
    expect(expired.status).toBe(2)
    expect(Date.now() - started).toBeLessThan(2500)
  })
})
