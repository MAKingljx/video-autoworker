// @vitest-environment node

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const deployPath = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
const deploySource = readFileSync(deployPath, 'utf8')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function listenerHelperSource(): string {
  const start = deploySource.indexOf('lsof_listener_pids_with_binary() {')
  const end = deploySource.indexOf('\n}\n\nlsof_listener_pids() {', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return deploySource.slice(start, end + 2)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'video-autoworker-lsof-status-'))
  roots.push(root)
  const trace = join(root, 'trace')
  const fake = join(root, 'lsof')
  writeFileSync(fake, `#!/bin/bash
printf '%s\\n' "$@" > "$AIWORKER_LSOF_TRACE"
case "$AIWORKER_LSOF_MODE" in
  pid) printf '42\\n7\\n42\\n'; exit 0 ;;
  warning) printf '42\\n'; printf 'lsof warning\\n' >&2; exit 0 ;;
  empty) exit 1 ;;
  denied) printf 'permission denied\\n' >&2; exit 1 ;;
  failed) printf 'partial\\n'; printf 'query failed\\n' >&2; exit 2 ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 })
  chmodSync(fake, 0o700)
  return { root, trace, fake }
}

function query(mode: string, port = '3017', direct = false) {
  const entry = fixture()
  const source = `set -euo pipefail
${listenerHelperSource()}
if [[ "$AIWORKER_LSOF_DIRECT" == 1 ]]; then
  lsof_listener_pids_with_binary "$AIWORKER_LSOF_BIN" "$AIWORKER_LSOF_PORT"
else
  value="$(lsof_listener_pids_with_binary "$AIWORKER_LSOF_BIN" "$AIWORKER_LSOF_PORT")"
  printf '%s' "$value"
fi
`
  const result = spawnSync('/bin/bash', ['-c', source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AIWORKER_LSOF_BIN: entry.fake,
      AIWORKER_LSOF_MODE: mode,
      AIWORKER_LSOF_PORT: port,
      AIWORKER_LSOF_DIRECT: direct ? '1' : '0',
      AIWORKER_LSOF_TRACE: entry.trace,
    },
  })
  return { ...entry, result }
}

describe('blue-green listener status contract', () => {
  it('treats native lsof exit 1 with empty output as an empty successful query under pipefail', () => {
    const { result, trace } = query('empty')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(readFileSync(trace, 'utf8')).toBe('-tiTCP:3017\n-sTCP:LISTEN\n')
  })

  it('sorts native PID output and preserves successful diagnostics', () => {
    const pid = query('pid').result
    expect(pid.status, pid.stderr).toBe(0)
    expect(pid.stdout).toBe('42\n7')
    const warning = query('warning').result
    expect(warning.status).toBe(0)
    expect(warning.stdout).toBe('42')
    expect(warning.stderr).toBe('lsof warning\n')
  })

  it('preserves exit 1 errors and other native failures without swallowing output', () => {
    const denied = query('denied', '3017', true).result
    expect(denied.status).toBe(1)
    expect(denied.stdout).toBe('')
    expect(denied.stderr).toBe('permission denied\n')
    const failed = query('failed', '3017', true).result
    expect(failed.status).toBe(2)
    expect(failed.stdout).toBe('partial\n')
    expect(failed.stderr).toBe('query failed\n')
  })

  it('rejects invalid ports before invoking lsof', () => {
    for (const port of ['0', '65536', '03017', 'not-a-port']) {
      const { result, trace } = query('pid', port, true)
      expect(result.status).toBe(2)
      expect(() => readFileSync(trace)).toThrow()
    }
  })

  it('uses the fixed native helper at every listener query call site', () => {
    expect(deploySource).toContain('LSOF_BIN=/usr/sbin/lsof')
    expect(deploySource).toContain('lsof_listener_pids_with_binary "$LSOF_BIN"')
    expect(deploySource).not.toMatch(/\blsof -tiTCP:/u)
    expect(deploySource.match(/lsof_listener_pids /gu)).toHaveLength(5)
    expect(deploySource).toContain('router listener query failed after legacy shutdown')
    expect(deploySource).toContain('router listener query failed before managed baseline startup')
  })
})
