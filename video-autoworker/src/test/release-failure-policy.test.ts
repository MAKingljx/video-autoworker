// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseFailureAssessment, releaseFailurePolicy } from '../../scripts/lib/release-failure-policy.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function transition(policy: string, mode = 'switch') {
  const root = realpathSync(mkdtempSync('/tmp/release-policy-')); roots.push(root)
  const source = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
  const start = source.indexOf('transition_with_verification() {')
  const end = source.indexOf('\nswitch_slot() {', start)
  if (start < 0 || end < start) throw new Error('transition_function_missing')
  const harness = join(root, 'harness.sh')
  const trace = join(root, 'trace')
  writeFileSync(trace, '')
  writeFileSync(harness, `#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$1"
NODE_BIN="$2"
TRACE="$3"
AIWORKER_RELEASE_FAILURE_POLICY="$4"
MODE="$5"
active_slot=blue
previous_slot=green
state_generation=7
ROUTER_HOST=127.0.0.1
ROUTER_PORT=3017
READINESS_PATH=/api/n8n/release-readiness
fail() { printf '%s\\n' "$*" >&2; exit 1; }
read_state_field() { case "$1" in active) printf '%s' "$active_slot";; previous) printf '%s' "$previous_slot";; generation) printf '%s' "$state_generation";; esac; }
read_state_slot_release() { printf 'release-%s' "$1"; }
binding_values() { printf 'release-%s\\n/private/artifact\\n' "$1"; }
slot_port() { printf '3018'; }
preflight_transition() { :; }
check_json_endpoint() { printf '3\\n1\\n${'a'.repeat(64)}\\n0\\n0\\n0\\n'; }
verify_director_video_release_chain() { printf '${'a'.repeat(64)}'; }
capture_transition_release_evidence() { printf '%s' "$1"; }
verify_captured_transition_release_evidence() { [[ "$2" == blue ]]; }
probe_slot() { printf 'probe:%s\\n' "$1" >> "$TRACE"; }
rollback_owned_worker_handoff() { printf 'owned-worker-handoff\\n' >> "$TRACE"; }
update_state() { previous_slot="$active_slot"; active_slot="$1"; state_generation=$((state_generation+1)); printf 'route:%s:%s:%s\\n' "$2" "$active_slot" "$state_generation" >> "$TRACE"; }
${source.slice(start, end)}
transition_with_verification green "$MODE"
`, { mode: 0o700 })
  let stderr = ''
  try {
    execFileSync('/bin/bash', [harness, process.cwd(), process.execPath, trace, policy, mode], {
      env: { NODE_ENV: 'test', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    })
  } catch (error) {
    stderr = String((error as { stderr?: Buffer }).stderr || '')
  }
  return { stderr, events: readFileSync(trace, 'utf8').trim().split('\n') }
}

describe('release failure policy', () => {
  it('defaults to assessment and never authorizes recovery from an unknown route', () => {
    expect(releaseFailurePolicy()).toBe('assess-first')
    expect(releaseFailureAssessment({ routeState: 'committed' })).toMatchObject({
      currentState: 'route_committed_unverified', nextAction: 'resume_after_assessment', restorePrevious: false, keepIntakeHold: true,
    })
    expect(releaseFailureAssessment({ policy: 'restore-previous', routeState: 'unknown' }).restorePrevious).toBe(false)
  })

  it('keeps the newly committed route and does not hand back worker ownership by default', () => {
    const result = transition('assess-first')
    expect(result.events, result.stderr).toEqual(['route:switch:green:8'])
    expect(result.stderr).toContain('"currentState":"route_committed_unverified"')
    expect(result.stderr).toContain('same-operation resume')
  })

  it('hands back only the owned worker before the explicitly selected previous-route restoration', () => {
    const result = transition('restore-previous')
    expect(result.events, result.stderr).toEqual(['route:switch:green:8', 'probe:blue', 'owned-worker-handoff', 'route:rollback:blue:9'])
    expect(result.stderr).toContain('explicit restore-previous policy selected')
  })

  it('does not bounce back again when an explicitly requested rollback itself fails verification', () => {
    const result = transition('restore-previous', 'rollback')
    expect(result.events, result.stderr).toEqual(['owned-worker-handoff', 'route:rollback:green:8'])
    expect(result.stderr).toContain('same-operation resume')
  })
})
