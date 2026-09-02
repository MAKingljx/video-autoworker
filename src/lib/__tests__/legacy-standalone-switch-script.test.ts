import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/switch-legacy-standalone-3017.sh')
const script = readFileSync(scriptPath, 'utf8')

function runFailureScenario(body: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-switch-test-'))
  const tracePath = resolve(directory, 'trace.log')
  const runningCommitPath = resolve(directory, 'RUNNING_COMMIT')
  const portPidPath = resolve(directory, 'video-autoworker-3017.pid')
  const genericPidPath = resolve(directory, 'video-autoworker.pid')
  writeFileSync(runningCommitPath, '0000000000000000000000000000000000000001\n')
  writeFileSync(portPidPath, '101\n')
  writeFileSync(genericPidPath, '101\n')
  try {
    const source = `
source ${JSON.stringify(scriptPath)}
trace_file=${JSON.stringify(tracePath)}
old_pid=101
old_process_start=old-start
OLD_COMMIT=0000000000000000000000000000000000000001
NEW_COMMIT=0000000000000000000000000000000000000002
OLD_RELEASE_ROOT=/old
NEW_RELEASE_ROOT=/new
LIVE_DB_PATH=/state/live.db
LIVE_TOKENS_PATH=/secrets/live-tokens.json
RUNTIME_DIR=${JSON.stringify(directory)}
PORT=3017
protected_before=protected
listener_pids() { return 0; }
process_start_identity() { printf 'start\\n'; }
stop_exact_runtime() { printf 'stop:%s:%s\\n' "$1" "$2" >> "$trace_file"; }
start_release() {
  printf 'start:%s:%s:%s:%s\\n' "$1" "$2" "$3" "$4" >> "$trace_file"
  if [[ "$1" == "$NEW_RELEASE_ROOT" ]]; then LAST_LAUNCHED_PID=202; else LAST_LAUNCHED_PID=303; fi
}
wait_and_verify_runtime() { printf 'verify:%s:%s\\n' "$1" "$2" >> "$trace_file"; return 0; }
write_runtime_markers() { printf 'markers:%s:%s\\n' "$1" "$2" >> "$trace_file"; return 0; }
assert_runtime_identity() { printf 'identity:%s:%s\\n' "$1" "$2" >> "$trace_file"; return 0; }
assert_protected_unchanged() { printf 'protected\\n' >> "$trace_file"; return 0; }
assert_live_tokens_unchanged() { return 0; }
live_tokens_state() { printf 'present:fixture\\n'; }
kill() { [[ "$1" == -0 && "\${2:-}" == 202 ]]; }
${body}
`
    const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
    const markers = {
      commit: readFileSync(runningCommitPath, 'utf8').trim(),
      portPid: readFileSync(portPidPath, 'utf8').trim(),
      genericPid: readFileSync(genericPidPath, 'utf8').trim(),
    }
    return {
      result,
      trace: readFileSync(tracePath, 'utf8').trim().split('\n'),
      markers,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('legacy 3017 standalone switch bridge', () => {
  it('is restricted to UI-only compatible releases and exact runtime identity', () => {
    expect(script).toContain('[[ "$PORT" == 3017 ]]')
    expect(script).toContain('EXPECTED_OLD_COMMIT=542eebdd871f0d960d972e879310bec7a3d15cca')
    expect(script).toContain('EXPECTED_NEW_COMMIT=d3ca02ecdcbffb778c9c65d540e1095bffea7138')
    expect(script).toContain('release diff is not 3017 UI-only')
    expect(script).toContain('runtime contract changed: $path')
    expect(script).toContain('$label cwd does not match its release')
    expect(script).toContain('$label does not hold the expected database FD')
    expect(script).toContain('legacy PID marker does not match the listener')
    expect(script).toContain('RUNNING_COMMIT does not identify the legacy release')
    expect(script).toContain('MC_OPENCLAW_PROFILE_TARGET="${MC_OPENCLAW_PROFILE_TARGET:-local}"')
    expect(script).toContain('MC_MATERIALS_REMOTE_PYTHON="${MC_MATERIALS_REMOTE_PYTHON:-/usr/bin/python3}"')
    expect(script).toContain('/api/status?action=health')
    expect(script).not.toContain('/api/health')
    expect(script).not.toContain('sqlite3')
    expect(script).not.toContain('launchctl')
    expect(script).not.toContain('n8n-import')
  })

  it('preflights both rollback and candidate releases before stopping live 3017', () => {
    const rollbackProbe = script.indexOf('probe_release "legacy-rollback"')
    const candidateProbe = script.indexOf('probe_release "candidate"')
    const liveSwitch = script.lastIndexOf('perform_live_switch')
    expect(rollbackProbe).toBeGreaterThan(0)
    expect(candidateProbe).toBeGreaterThan(rollbackProbe)
    expect(liveSwitch).toBeGreaterThan(candidateProbe)
  })

  it('treats an unused protected port as an empty listener set', () => {
    const source = `
source ${JSON.stringify(scriptPath)}
LSOF_BIN=/usr/bin/false
listener_pids 65534
`
    const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('resolves the default Node command to one executable path', () => {
    const source = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=node
resolve_node_bin
printf '%s' "$NODE_BIN"
`
    const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.startsWith('/')).toBe(true)
  })

  it('accepts a safely missing token file only at the data directory default path', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-missing-tokens-test-'))
    const liveDatabase = resolve(directory, 'mission-control.db')
    const liveTokens = resolve(realpathSync(directory), 'mission-control-tokens.json')
    try {
      chmodSync(directory, 0o700)
      writeFileSync(liveDatabase, '')
      const source = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=${JSON.stringify(process.execPath)}
LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
prepare_live_tokens_contract
assert_live_tokens_unchanged
printf '%s\\n' "$live_tokens_identity"
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/^missing:/)
      expect(() => statSync(liveTokens)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a missing token file outside the data directory default path', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-wrong-tokens-test-'))
    const liveDatabase = resolve(directory, 'mission-control.db')
    const liveTokens = resolve(directory, 'other-tokens.json')
    try {
      chmodSync(directory, 0o700)
      writeFileSync(liveDatabase, '')
      const source = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=${JSON.stringify(process.execPath)}
LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
prepare_live_tokens_contract
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('missing live tokens is allowed only at the data directory default path')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a missing default token path with an unsafe parent or a dangling symlink', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-unsafe-tokens-test-'))
    const unsafeDirectory = resolve(directory, 'unsafe')
    const liveDatabase = resolve(unsafeDirectory, 'mission-control.db')
    try {
      mkdirSync(unsafeDirectory, { mode: 0o700 })
      const liveTokens = resolve(realpathSync(unsafeDirectory), 'mission-control-tokens.json')
      writeFileSync(liveDatabase, '')
      chmodSync(unsafeDirectory, 0o777)
      const unsafeParentSource = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=${JSON.stringify(process.execPath)}
LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
prepare_live_tokens_contract
`
      const unsafeParent = spawnSync('/bin/bash', ['-c', unsafeParentSource], { encoding: 'utf8' })
      expect(unsafeParent.status).not.toBe(0)
      expect(unsafeParent.stderr).toContain('live tokens parent directory is group/other writable')

      chmodSync(unsafeDirectory, 0o700)
      symlinkSync(resolve(unsafeDirectory, 'absent-target'), liveTokens)
      const danglingSymlink = spawnSync('/bin/bash', ['-c', unsafeParentSource], { encoding: 'utf8' })
      expect(danglingSymlink.status).not.toBe(0)
      expect(danglingSymlink.stderr).toContain('live tokens is missing or unsafe')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the existing token file owner, type and mode contract', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-existing-tokens-test-'))
    const liveDatabase = resolve(directory, 'mission-control.db')
    const liveTokens = resolve(directory, 'custom-tokens.json')
    try {
      chmodSync(directory, 0o700)
      writeFileSync(liveDatabase, '')
      writeFileSync(liveTokens, '[]\n', { mode: 0o600 })
      const source = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=${JSON.stringify(process.execPath)}
LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
prepare_live_tokens_contract
assert_live_tokens_unchanged
printf '%s\\n' "$live_tokens_identity"
`
      const accepted = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(accepted.status).toBe(0)
      expect(accepted.stdout).toMatch(/^present:/)

      chmodSync(liveTokens, 0o644)
      const rejected = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('live tokens must have mode 0600')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('detects a token file appearing after a safely missing snapshot', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-token-race-test-'))
    const liveDatabase = resolve(directory, 'mission-control.db')
    const liveTokens = resolve(realpathSync(directory), 'mission-control-tokens.json')
    try {
      chmodSync(directory, 0o700)
      writeFileSync(liveDatabase, '')
      const source = `
source ${JSON.stringify(scriptPath)}
NODE_BIN=${JSON.stringify(process.execPath)}
LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
prepare_live_tokens_contract
printf '[]\\n' > "$LIVE_TOKENS_PATH"
chmod 600 "$LIVE_TOKENS_PATH"
assert_live_tokens_unchanged
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('live tokens presence or identity changed during the 3017 switch')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rechecks token identity around probe and live transition boundaries', () => {
    const mainStart = script.indexOf('main() {')
    const transitionStart = script.indexOf('perform_live_switch() {')
    const mainBody = script.slice(mainStart)
    const transitionBody = script.slice(transitionStart, mainStart)
    expect(mainBody.match(/assert_live_tokens_unchanged/g)?.length).toBeGreaterThanOrEqual(3)
    expect(transitionBody.match(/assert_live_tokens_unchanged/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('writes and verifies the complete marker bundle with private modes', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-marker-test-'))
    const commit = 'd3ca02ecdcbffb778c9c65d540e1095bffea7138'
    try {
      const source = `
source ${JSON.stringify(scriptPath)}
RUNTIME_DIR=${JSON.stringify(directory)}
write_runtime_markers ${commit} 4242
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      for (const [name, value] of [
        ['RUNNING_COMMIT', commit],
        ['video-autoworker-3017.pid', '4242'],
        ['video-autoworker.pid', '4242'],
      ] as const) {
        const pathname = resolve(directory, name)
        expect(readFileSync(pathname, 'utf8').trim()).toBe(value)
        expect(statSync(pathname).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('atomically restores the old release when candidate verification fails', () => {
    const { result, trace } = runFailureScenario(`
wait_and_verify_runtime() {
  printf 'verify:%s:%s\\n' "$1" "$2" >> "$trace_file"
  [[ "$2" != 202 ]]
}
trap on_exit EXIT
perform_live_switch
`)
    expect(result.status).not.toBe(0)
    expect(trace).toEqual([
      'stop:legacy runtime:101',
      'start:/new:3017:/state/live.db:/secrets/live-tokens.json',
      'verify:candidate runtime:202',
      'stop:failed candidate runtime:202',
      'start:/old:3017:/state/live.db:/secrets/live-tokens.json',
      'verify:restored legacy runtime:303',
      'markers:0000000000000000000000000000000000000001:303',
      'protected',
    ])
  })

  it('replaces a mid-write marker mix with the restored runtime identity', () => {
    const { result, trace, markers } = runFailureScenario(`
atomic_attempt=0
atomic_write_marker() {
  atomic_attempt=$((atomic_attempt + 1))
  printf 'atomic:%s:%s:%s\\n' "$1" "$2" "$atomic_attempt" >> "$trace_file"
  (( atomic_attempt != 2 )) || return 1
  printf '%s\\n' "$2" > "$1"
}
write_runtime_markers() {
  local commit="$1" pid="$2"
  atomic_write_marker "$RUNTIME_DIR/RUNNING_COMMIT" "$commit"
  atomic_write_marker "$RUNTIME_DIR/video-autoworker-3017.pid" "$pid"
  atomic_write_marker "$RUNTIME_DIR/video-autoworker.pid" "$pid"
}
trap on_exit EXIT
perform_live_switch
`)
    expect(result.status).not.toBe(0)
    expect(trace.some((line) => line.endsWith(':0000000000000000000000000000000000000002:1'))).toBe(true)
    expect(trace.some((line) => line.endsWith(':202:2'))).toBe(true)
    expect(markers).toEqual({
      commit: '0000000000000000000000000000000000000001',
      portPid: '303',
      genericPid: '303',
    })
  })

  it('rejects a protected PID drift and still restarts the legacy release', () => {
    const { result, trace } = runFailureScenario(`
protected_attempt=0
assert_protected_unchanged() {
  protected_attempt=$((protected_attempt + 1))
  printf 'protected:%s\\n' "$protected_attempt" >> "$trace_file"
  (( protected_attempt != 1 ))
}
trap on_exit EXIT
perform_live_switch
`)
    expect(result.status).not.toBe(0)
    expect(trace).toContain('start:/old:3017:/state/live.db:/secrets/live-tokens.json')
    expect(trace).toContain('markers:0000000000000000000000000000000000000001:303')
  })

  it('prioritizes restoring legacy with a changed but independently safe token state', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-rollback-token-state-test-'))
    const tracePath = resolve(directory, 'trace.log')
    try {
      const source = `
source ${JSON.stringify(scriptPath)}
trace_file=${JSON.stringify(tracePath)}
new_pid=''
OLD_RELEASE_ROOT=/old
OLD_COMMIT=0000000000000000000000000000000000000001
LIVE_DB_PATH=/state/live.db
LIVE_TOKENS_PATH=/state/mission-control-tokens.json
RUNTIME_DIR=${JSON.stringify(directory)}
PORT=3017
live_tokens_identity=missing:original-parent
listener_pids() { return 0; }
live_tokens_state() {
  printf 'tokens-state:safe-current\\n' >> "$trace_file"
  printf 'present:safe-current\\n'
}
start_release() {
  printf 'start:%s:%s:%s:%s\\n' "$1" "$2" "$3" "$4" >> "$trace_file"
  LAST_LAUNCHED_PID=303
}
wait_and_verify_runtime() { printf 'verify:%s:%s\\n' "$1" "$2" >> "$trace_file"; return 0; }
process_start_identity() { printf 'restored-start\\n'; }
write_runtime_markers() { printf 'markers:%s:%s\\n' "$1" "$2" >> "$trace_file"; return 0; }
assert_protected_unchanged() { printf 'protected\\n' >> "$trace_file"; return 0; }
rollback_live
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
        'tokens-state:safe-current',
        'start:/old:3017:/state/live.db:/state/mission-control-tokens.json',
        'verify:restored legacy runtime:303',
        'markers:0000000000000000000000000000000000000001:303',
        'protected',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not restart legacy when the current token state is unsafe', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-unsafe-rollback-token-test-'))
    const tracePath = resolve(directory, 'trace.log')
    try {
      const source = `
source ${JSON.stringify(scriptPath)}
trace_file=${JSON.stringify(tracePath)}
new_pid=''
OLD_RELEASE_ROOT=/old
LIVE_DB_PATH=/state/live.db
LIVE_TOKENS_PATH=/state/mission-control-tokens.json
RUNTIME_DIR=${JSON.stringify(directory)}
PORT=3017
listener_pids() { return 0; }
live_tokens_state() { printf 'tokens-state:unsafe\\n' >> "$trace_file"; return 1; }
start_release() { printf 'UNSAFE-START\\n' >> "$trace_file"; }
rollback_live
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(readFileSync(tracePath, 'utf8').trim()).toBe('tokens-state:unsafe')
      expect(result.stderr).toContain('cannot restore legacy runtime with unsafe live tokens state')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not enter the live stop path in preflight-only mode', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'legacy-3017-preflight-test-'))
    const tracePath = resolve(directory, 'trace.log')
    const liveDatabase = resolve(directory, 'mission-control.db')
    const liveTokens = resolve(directory, 'mission-control-tokens.json')
    const probeDirectory = resolve(directory, 'probe')
    const probeDatabase = resolve(probeDirectory, 'mission-control.db')
    try {
      mkdirSync(probeDirectory)
      writeFileSync(liveDatabase, '')
      writeFileSync(probeDatabase, '')
      const source = `
source ${JSON.stringify(scriptPath)}
trace_file=${JSON.stringify(tracePath)}
parse_args() {
  APPLY=0
  OLD_RELEASE_ROOT=/old
  OLD_COMMIT=542eebdd871f0d960d972e879310bec7a3d15cca
  NEW_RELEASE_ROOT=/new
  NEW_COMMIT=d3ca02ecdcbffb778c9c65d540e1095bffea7138
  LIVE_DB_PATH=${JSON.stringify(liveDatabase)}
  LIVE_TOKENS_PATH=${JSON.stringify(liveTokens)}
  PROBE_DATA_DIR=${JSON.stringify(probeDirectory)}
  SOURCE_APP_DIR=${JSON.stringify(directory)}
  RUNTIME_DIR=${JSON.stringify(directory)}
  NODE_BIN=/bin/bash
  LSOF_BIN=/bin/bash
  CURL_BIN=/bin/bash
}
assert_full_commit() { return 0; }
require_absolute() { return 0; }
assert_safe_directory() { return 0; }
assert_private_file() { return 0; }
assert_release() { return 0; }
assert_ui_only_diff() { return 0; }
physical_path() { printf '%s\\n' "$1"; }
assert_live_legacy_identity() { printf 'live-identity\\n' >> "$trace_file"; }
capture_protected_listeners() { printf 'protected'; }
assert_protected_unchanged() { printf 'protected-unchanged\\n' >> "$trace_file"; }
probe_release() { printf 'probe:%s\\n' "$1" >> "$trace_file"; }
perform_live_switch() { printf 'LIVE-SWITCH\\n' >> "$trace_file"; }
main
`
      const result = spawnSync('/bin/bash', ['-c', source], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
        'live-identity',
        'probe:legacy-rollback',
        'probe:candidate',
        'live-identity',
        'protected-unchanged',
      ])
      expect(() => statSync(liveTokens)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
