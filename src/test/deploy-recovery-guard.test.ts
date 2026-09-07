// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')

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
${shellFunction('guard_mode_requires_handoff', 'verify_deployment_source_gate')}
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
})
