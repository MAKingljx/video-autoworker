#!/usr/bin/env bash

set -euo pipefail
umask 077

# One-time bridge for a legacy single-process 3017 release. It deliberately
# does not build code, run database tooling, import n8n workflows, or manage any
# service other than the exact 3017 PID supplied by current runtime evidence.

PORT=3017
PROBE_PORT=3018
APPLY=0
ROLLBACK=0
EXPECTED_OLD_COMMIT=d3ca02ecdcbffb778c9c65d540e1095bffea7138
EXPECTED_NEW_COMMIT=57f6e6cd671245c45d15439de7e39630869cc0ff
OLD_RELEASE_ROOT=""
OLD_COMMIT=""
NEW_RELEASE_ROOT=""
NEW_COMMIT=""
LIVE_DB_PATH=""
LIVE_TOKENS_PATH=""
PROBE_DATA_DIR=""
SOURCE_APP_DIR=""
RUNTIME_DIR=""
PLATFORM_ENV_FILE="${AIWORKER_PLATFORM_ENV_FILE:-$HOME/.config/video-autoworker/platform.env}"
NODE_BIN="${NODE_BIN:-node}"
LSOF_BIN="${LSOF_BIN:-/usr/sbin/lsof}"
CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PROTECTED_PORTS="${AIWORKER_LEGACY_SWITCH_PROTECTED_PORTS:-5678 5679 18789 18889 18989 18091 18092 18094 11434}"

transition_started=0
switch_complete=0
old_stop_requested=0
old_pid=""
new_pid=""
old_process_start=""
protected_before=""
live_tokens_identity=""
live_database_identity=""
LAST_LAUNCHED_PID=""
SWITCH_DIRECTION=forward
SOURCE_PROBE_LABEL=legacy-rollback
TARGET_PROBE_LABEL=candidate
SOURCE_RUNTIME_LABEL="legacy runtime"
TARGET_RUNTIME_LABEL="candidate runtime"
FAILED_TARGET_LABEL="failed candidate runtime"
RESTORED_SOURCE_LABEL="restored legacy runtime"
PARTIAL_SOURCE_LABEL="partially stopping legacy runtime"

usage() {
  cat <<'EOF'
Usage: switch-legacy-standalone-3017.sh [--rollback] [--apply] \
  --old-release-root ABS --old-commit FULL_SHA \
  --new-release-root ABS --new-commit FULL_SHA \
  --live-db ABS --live-tokens ABS --probe-data-dir ABS \
  --source-app-dir ABS --runtime-dir ABS [--node-bin ABS]

Without --apply the script performs the full identity, rollback-start and
candidate-start preflight, then exits without stopping the live 3017 process.
The probe directory must already contain a non-production mission-control.db.
Use --rollback without --apply to preflight the responsive UI release ->
d3ca02e, then repeat the exact command with --apply to perform that rollback. The old/new arguments
always retain their fixed release meanings and must not be exchanged.
EOF
}

fail() {
  printf 'legacy 3017 switch failed: %s\n' "$*" >&2
  return 1
}

require_absolute() {
  [[ "$2" == /* && "$2" != *[$'\r\n']* ]] \
    || { fail "$1 must be one absolute path"; return 1; }
}

physical_path() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$1"
}

resolve_node_bin() {
  if [[ "$NODE_BIN" != /* ]]; then
    [[ "$NODE_BIN" != */* && "$NODE_BIN" =~ ^[A-Za-z0-9._+-]+$ ]] \
      || { fail "Node executable must be an absolute path or one command name"; return 1; }
    NODE_BIN="$(command -v "$NODE_BIN")" \
      || { fail "Node executable is unavailable"; return 1; }
  fi
  require_absolute "Node executable" "$NODE_BIN" || return 1
  [[ -x "$NODE_BIN" ]] || { fail "Node executable is unavailable"; return 1; }
}

assert_private_file() {
  local label="$1" pathname="$2" mode
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] \
    || { fail "$label is missing or unsafe"; return 1; }
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")" \
    || { fail "$label mode cannot be read"; return 1; }
  [[ "$mode" == 600 ]] || { fail "$label must have mode 0600"; return 1; }
}

assert_safe_directory() {
  local label="$1" pathname="$2" mode
  [[ -d "$pathname" && ! -L "$pathname" && -O "$pathname" ]] \
    || { fail "$label is missing or unsafe"; return 1; }
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")" \
    || { fail "$label mode cannot be read"; return 1; }
  (( (8#$mode & 8#022) == 0 )) \
    || { fail "$label is group/other writable"; return 1; }
}

stat_identity() {
  stat -f '%d:%i:%u:%Lp:%l' "$1" 2>/dev/null \
    || stat -c '%d:%i:%u:%a:%h' "$1"
}

live_database_state() {
  local first second database_dev database_ino database_uid database_mode database_nlink
  [[ -f "$LIVE_DB_PATH" && ! -L "$LIVE_DB_PATH" && -O "$LIVE_DB_PATH" ]] \
    || { fail "live database is missing or unsafe"; return 1; }
  first="$(stat_identity "$LIVE_DB_PATH")" \
    || { fail "live database identity is unavailable"; return 1; }
  IFS=: read -r database_dev database_ino database_uid database_mode database_nlink <<< "$first"
  [[ -n "$database_dev" && -n "$database_ino" && -n "$database_uid" \
    && "$database_mode" =~ ^[0-7]{3,4}$ && "$database_nlink" =~ ^[0-9]+$ ]] \
    || { fail "live database identity is invalid"; return 1; }
  (( (8#$database_mode & 8#022) == 0 )) \
    || { fail "live database is group/other writable"; return 1; }
  [[ "$database_nlink" == 1 ]] \
    || { fail "live database link count is unsafe"; return 1; }
  [[ -f "$LIVE_DB_PATH" && ! -L "$LIVE_DB_PATH" && -O "$LIVE_DB_PATH" ]] \
    || { fail "live database changed during validation"; return 1; }
  second="$(stat_identity "$LIVE_DB_PATH")" \
    || { fail "live database identity is unavailable"; return 1; }
  [[ "$first" == "$second" ]] \
    || { fail "live database identity changed during validation"; return 1; }
  printf '%s\n' "$first"
}

prepare_live_database_contract() {
  live_database_identity="$(live_database_state)" || return 1
  [[ -n "$live_database_identity" ]] \
    || { fail "live database identity is unavailable"; return 1; }
}

assert_live_database_unchanged() {
  local current
  current="$(live_database_state)" || return 1
  [[ "$current" == "$live_database_identity" ]] \
    || { fail "live database identity changed during the 3017 switch"; return 1; }
}

live_tokens_state() {
  local expected_default parent physical_parent first second
  if [[ -e "$LIVE_TOKENS_PATH" || -L "$LIVE_TOKENS_PATH" ]]; then
    assert_private_file "live tokens" "$LIVE_TOKENS_PATH" || return 1
    first="$(stat_identity "$LIVE_TOKENS_PATH")" \
      || { fail "live tokens identity is unavailable"; return 1; }
    assert_private_file "live tokens" "$LIVE_TOKENS_PATH" || return 1
    second="$(stat_identity "$LIVE_TOKENS_PATH")" \
      || { fail "live tokens identity is unavailable"; return 1; }
    [[ "$first" == "$second" ]] \
      || { fail "live tokens identity changed during validation"; return 1; }
    printf 'present:%s\n' "$first"
    return
  fi

  expected_default="$(dirname "$LIVE_DB_PATH")/mission-control-tokens.json" \
    || { fail "live database parent cannot be resolved"; return 1; }
  [[ "$LIVE_TOKENS_PATH" == "$expected_default" ]] \
    || { fail "missing live tokens is allowed only at the data directory default path"; return 1; }
  [[ ! -L "$LIVE_TOKENS_PATH" ]] \
    || { fail "missing live tokens path must not be a symlink"; return 1; }
  parent="$(dirname "$LIVE_TOKENS_PATH")" \
    || { fail "live tokens parent cannot be resolved"; return 1; }
  assert_safe_directory "live tokens parent directory" "$parent" || return 1
  physical_parent="$(physical_path "$parent")" \
    || { fail "live tokens parent directory cannot be resolved"; return 1; }
  [[ "$physical_parent" == "$parent" ]] \
    || { fail "live tokens parent directory must use its physical path"; return 1; }
  first="$(stat_identity "$parent")" \
    || { fail "live tokens parent identity is unavailable"; return 1; }
  [[ ! -e "$LIVE_TOKENS_PATH" && ! -L "$LIVE_TOKENS_PATH" ]] \
    || { fail "live tokens appeared during validation"; return 1; }
  assert_safe_directory "live tokens parent directory" "$parent" || return 1
  second="$(stat_identity "$parent")" \
    || { fail "live tokens parent identity is unavailable"; return 1; }
  [[ "$first" == "$second" ]] \
    || { fail "live tokens parent identity changed during validation"; return 1; }
  printf 'missing:%s\n' "$first"
}

prepare_live_tokens_contract() {
  if [[ -e "$LIVE_TOKENS_PATH" || -L "$LIVE_TOKENS_PATH" ]]; then
    assert_private_file "live tokens" "$LIVE_TOKENS_PATH" || return 1
    LIVE_TOKENS_PATH="$(physical_path "$LIVE_TOKENS_PATH")" \
      || { fail "live tokens path cannot be resolved"; return 1; }
  fi
  live_tokens_identity="$(live_tokens_state)" || return 1
  [[ -n "$live_tokens_identity" ]] \
    || { fail "live tokens identity is unavailable"; return 1; }
}

assert_live_tokens_unchanged() {
  local current
  current="$(live_tokens_state)" || return 1
  [[ "$current" == "$live_tokens_identity" ]] \
    || { fail "live tokens presence or identity changed during the 3017 switch"; return 1; }
}

assert_live_tokens_safe_for_rollback() {
  local current
  current="$(live_tokens_state)" \
    || { fail "cannot restore legacy runtime with unsafe live tokens state"; return 1; }
  if [[ "$current" != "$live_tokens_identity" ]]; then
    printf '%s\n' \
      'WARNING: live tokens identity changed during the 3017 switch; using the independently validated safe state only for rollback' >&2
  fi
}

assert_full_commit() {
  [[ "$2" =~ ^[a-f0-9]{40}$ ]] \
    || { fail "$1 must be one full Git commit"; return 1; }
}

release_standalone_root() {
  printf '%s/.next/standalone\n' "$1"
}

assert_release() {
  local label="$1" release_root="$2" expected_commit="$3" actual standalone brain_marker
  assert_safe_directory "$label" "$release_root" || return 1
  actual="$(/usr/bin/git -C "$release_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || { fail "$label is not a Git worktree"; return 1; }
  [[ "$actual" == "$expected_commit" ]] \
    || { fail "$label commit does not match"; return 1; }
  /usr/bin/git -C "$release_root" diff --quiet --ignore-submodules -- \
    || { fail "$label has tracked worktree changes"; return 1; }
  /usr/bin/git -C "$release_root" diff --cached --quiet --ignore-submodules -- \
    || { fail "$label has staged changes"; return 1; }
  standalone="$(release_standalone_root "$release_root")" || return 1
  [[ -d "$standalone" && ! -L "$standalone" && -f "$standalone/server.js" \
    && ! -L "$standalone/server.js" ]] \
    || { fail "$label standalone server is unavailable"; return 1; }
  [[ -d "$standalone/.next/static" && -d "$standalone/public" ]] \
    || { fail "$label static/public assets are not assembled"; return 1; }
  brain_marker="$(find "$release_root" -name .PhoenixBrain -print -quit 2>/dev/null)" \
    || { fail "$label private routing metadata scan failed"; return 1; }
  if [[ -n "$brain_marker" ]]; then
    fail "$label contains private .PhoenixBrain routing metadata"
    return 1
  fi
}

assert_ui_only_diff() {
  local changed_paths expected_paths
  /usr/bin/git -C "$SOURCE_APP_DIR" merge-base --is-ancestor "$OLD_COMMIT" "$NEW_COMMIT" \
    || { fail "new release is not a descendant of the old release"; return 1; }
  changed_paths="$(/usr/bin/git -C "$SOURCE_APP_DIR" diff --name-only "$OLD_COMMIT..$NEW_COMMIT")" \
    || { fail "release diff cannot be read"; return 1; }
  expected_paths="$(printf '%s\n' \
    docs/operations/2026/2026-09-03.md \
    src/app/globals.css \
    src/components/dashboard/widget-grid.tsx \
    src/components/dashboard/widgets/event-stream-widget.tsx \
    src/components/dashboard/widgets/session-workbench-widget.tsx \
    tests/dashboard-overview-layout.spec.ts)" \
    || { fail "expected release path set cannot be built"; return 1; }
  [[ "$changed_paths" == "$expected_paths" ]] \
    || { fail "release diff is not the exact verified 3017 overview UI patch"; return 1; }

  for path in \
    src/lib/db.ts \
    src/lib/migrations.ts \
    src/lib/config.ts \
    src/lib/scheduler.ts \
    scripts/deploy-standalone.sh \
    scripts/start-standalone.sh \
    ops/n8n/workflows/aiworker-task-intake.json \
    ops/n8n/workflows/aiworker-video-analysis.json; do
    /usr/bin/git -C "$SOURCE_APP_DIR" diff --quiet "$OLD_COMMIT..$NEW_COMMIT" -- "$path" \
      || { fail "runtime contract changed: $path"; return 1; }
  done
}

listener_pids() {
  local output status=0
  output="$("$LSOF_BIN" -nP -tiTCP:"$1" -sTCP:LISTEN 2>&1)" || status=$?
  if (( status == 0 )); then
    printf '%s\n' "$output" | sed '/^$/d' | sort -u || return 1
    return
  fi
  if (( status == 1 )) && [[ -z "$output" ]]; then
    return 0
  fi
  fail "listener state for port $1 cannot be inspected"
  return 1
}

single_listener_pid() {
  local values count
  values="$(listener_pids "$1")" || return 1
  count="$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d '[:space:]')" \
    || { fail "port $1 listener count cannot be read"; return 1; }
  [[ "$count" == 1 ]] \
    || { fail "port $1 does not have exactly one listener"; return 1; }
  printf '%s\n' "$values"
}

process_cwd() {
  "$LSOF_BIN" -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p'
}

process_start_identity() {
  /bin/ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

process_has_database() {
  local pid="$1" expected="$2"
  "$LSOF_BIN" -a -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -Fxq "$expected"
}

assert_runtime_identity() {
  local label="$1" pid="$2" release_root="$3" port="$4" database="$5" expected_cwd listener actual_cwd
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { fail "$label PID is invalid"; return 1; }
  kill -0 "$pid" 2>/dev/null || { fail "$label PID is not running"; return 1; }
  expected_cwd="$(physical_path "$(release_standalone_root "$release_root")")" \
    || { fail "$label standalone cwd cannot be resolved"; return 1; }
  actual_cwd="$(process_cwd "$pid")" \
    || { fail "$label cwd cannot be read"; return 1; }
  [[ "$actual_cwd" == "$expected_cwd" ]] \
    || { fail "$label cwd does not match its release"; return 1; }
  listener="$(single_listener_pid "$port")" || return 1
  [[ "$listener" == "$pid" ]] \
    || { fail "$label does not own port $port"; return 1; }
  process_has_database "$pid" "$database" \
    || { fail "$label does not hold the expected database FD"; return 1; }
}

assert_live_source_identity() {
  local recorded
  old_pid="$(single_listener_pid "$PORT")" || return 1
  assert_runtime_identity "$SOURCE_RUNTIME_LABEL" "$old_pid" "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" \
    || return 1
  old_process_start="$(process_start_identity "$old_pid")" \
    || { fail "source process start identity cannot be read"; return 1; }
  [[ -n "$old_process_start" ]] \
    || { fail "source process start identity is unavailable"; return 1; }
  for pathname in "$RUNTIME_DIR/video-autoworker-3017.pid" "$RUNTIME_DIR/video-autoworker.pid"; do
    assert_private_file "source PID marker" "$pathname" || return 1
    recorded="$(tr -d '[:space:]' < "$pathname")" \
      || { fail "source PID marker cannot be read"; return 1; }
    [[ "$recorded" == "$old_pid" ]] \
      || { fail "source PID marker does not match the listener"; return 1; }
  done
  assert_private_file "RUNNING_COMMIT" "$RUNTIME_DIR/RUNNING_COMMIT" || return 1
  recorded="$(tr -d '[:space:]' < "$RUNTIME_DIR/RUNNING_COMMIT")" \
    || { fail "RUNNING_COMMIT cannot be read"; return 1; }
  [[ "$recorded" == "$OLD_COMMIT" ]] \
    || { fail "RUNNING_COMMIT does not identify the live source release"; return 1; }
}

capture_protected_listeners() {
  local port values
  for port in $PROTECTED_PORTS; do
    [[ "$port" =~ ^[1-9][0-9]*$ ]] && (( 10#$port <= 65535 )) \
      || { fail "protected port list is invalid"; return 1; }
    values="$(listener_pids "$port" | tr '\n' ',' | sed 's/,$//')" \
      || { fail "protected listener state cannot be read"; return 1; }
    printf '%s=%s\n' "$port" "$values" || return 1
  done
}

assert_protected_unchanged() {
  local after
  after="$(capture_protected_listeners)" || return 1
  [[ "$after" == "$protected_before" ]] \
    || { fail "a protected listener changed during the 3017 switch"; return 1; }
}

load_env_file() {
  local pathname="$1"
  [[ -e "$pathname" || -L "$pathname" ]] || return 0
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] \
    || { fail "refusing unsafe environment file: $pathname"; return 1; }
  set -a
  # shellcheck disable=SC1090
  source "$pathname" || { set +a; fail "environment file could not be loaded: $pathname"; return 1; }
  set +a
}

start_release() {
  local release_root="$1" port="$2" database="$3" tokens="$4" mode="$5" log_path="$6"
  local standalone data_dir
  standalone="$(release_standalone_root "$release_root")" || return 1
  data_dir="$(dirname "$database")" || return 1
  (
    load_env_file "$SOURCE_APP_DIR/.env" || exit 1
    load_env_file "$SOURCE_APP_DIR/.env.local" || exit 1
    load_env_file "$PLATFORM_ENV_FILE" || exit 1
    export AIWORKER_SOURCE_APP_DIR="$SOURCE_APP_DIR"
    export MC_HOSTNAME=127.0.0.1 HOSTNAME=127.0.0.1 PORT="$port"
    export MC_OPENCLAW_PROFILE_TARGET="${MC_OPENCLAW_PROFILE_TARGET:-local}"
    export MC_MATERIALS_REMOTE_PYTHON="${MC_MATERIALS_REMOTE_PYTHON:-/usr/bin/python3}"
    export OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/ai-worker/bin/openclaw}"
    export MISSION_CONTROL_DATA_DIR="$data_dir"
    export MISSION_CONTROL_DB_PATH="$database"
    export MISSION_CONTROL_TOKENS_PATH="$tokens"
    if [[ "$mode" == probe ]]; then
      export MISSION_CONTROL_TEST_MODE=1
    else
      unset MISSION_CONTROL_TEST_MODE
    fi
    cd "$standalone" || exit 1
    exec "$NODE_BIN" server.js
  ) >>"$log_path" 2>&1 &
  LAST_LAUNCHED_PID=$!
}

wait_and_verify_runtime() {
  local label="$1" pid="$2" release_root="$3" port="$4" database="$5" attempt
  for (( attempt = 1; attempt <= 80; attempt++ )); do
    if kill -0 "$pid" 2>/dev/null \
      && "$CURL_BIN" -fsS --max-time 2 "http://127.0.0.1:$port/api/status?action=health" >/dev/null 2>&1; then
      assert_runtime_identity "$label" "$pid" "$release_root" "$port" "$database" || return 1
      return 0
    fi
    sleep 0.25 || { fail "$label health wait was interrupted"; return 1; }
  done
  fail "$label did not become healthy"
  return 1
}

stop_exact_runtime() {
  local label="$1" pid="$2" release_root="$3" port="$4" expected_start="${5:-}"
  local attempt current_start cwd expected_cwd listeners unique_listener
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || { fail "$label PID is invalid"; return 1; }
  kill -0 "$pid" 2>/dev/null || return 0
  expected_cwd="$(physical_path "$(release_standalone_root "$release_root")")" \
    || { fail "$label standalone cwd cannot be resolved before stop"; return 1; }
  cwd="$(process_cwd "$pid")" \
    || { fail "$label cwd cannot be read before stop"; return 1; }
  [[ "$cwd" == "$expected_cwd" ]] \
    || { fail "$label PID identity changed before stop"; return 1; }
  if [[ -n "$expected_start" ]]; then
    current_start="$(process_start_identity "$pid")" \
      || { fail "$label process start cannot be read before stop"; return 1; }
    [[ "$current_start" == "$expected_start" ]] \
      || { fail "$label PID was reused before stop"; return 1; }
  fi
  listeners="$(listener_pids "$port")" || return 1
  if [[ -n "$listeners" ]]; then
    unique_listener="$(single_listener_pid "$port")" || return 1
    [[ "$unique_listener" == "$pid" ]] \
      || { fail "$label no longer uniquely owns port $port"; return 1; }
  fi
  if ! kill "$pid"; then
    kill -0 "$pid" 2>/dev/null || return 0
    fail "$label could not be sent SIGTERM"
    return 1
  fi
  for (( attempt = 1; attempt <= 120; attempt++ )); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25 || { fail "$label SIGTERM wait was interrupted"; return 1; }
  done
  cwd="$(process_cwd "$pid")" \
    || { fail "$label cwd cannot be read before SIGKILL"; return 1; }
  current_start="$(process_start_identity "$pid")" \
    || { fail "$label process start cannot be read before SIGKILL"; return 1; }
  [[ "$cwd" == "$expected_cwd" \
    && ( -z "$expected_start" || "$current_start" == "$expected_start" ) ]] \
    || { fail "$label identity changed before SIGKILL"; return 1; }
  if ! kill -9 "$pid"; then
    kill -0 "$pid" 2>/dev/null || return 0
    fail "$label could not be sent SIGKILL"
    return 1
  fi
  for (( attempt = 1; attempt <= 40; attempt++ )); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25 || { fail "$label SIGKILL wait was interrupted"; return 1; }
  done
  fail "$label did not stop"
  return 1
}

fsync_path() {
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const descriptor = fs.openSync(process.argv[1], fs.constants.O_RDONLY)
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  ' "$1"
}

atomic_write_marker() {
  local pathname="$1" value="$2" temporary
  temporary="$pathname.tmp.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] \
    || { fail "marker temporary path already exists"; return 1; }
  if ! printf '%s\n' "$value" > "$temporary"; then
    /bin/rm -f -- "$temporary" || { fail "marker temporary cleanup failed"; return 1; }
    fail "marker content write failed: $pathname"
    return 1
  fi
  if ! chmod 600 "$temporary"; then
    /bin/rm -f -- "$temporary" || { fail "marker temporary cleanup failed"; return 1; }
    fail "marker mode update failed: $pathname"
    return 1
  fi
  if ! fsync_path "$temporary"; then
    /bin/rm -f -- "$temporary" || { fail "marker temporary cleanup failed"; return 1; }
    fail "marker file fsync failed: $pathname"
    return 1
  fi
  if ! mv -f "$temporary" "$pathname"; then
    /bin/rm -f -- "$temporary" || { fail "marker temporary cleanup failed"; return 1; }
    fail "marker rename failed: $pathname"
    return 1
  fi
  fsync_path "$RUNTIME_DIR" \
    || { fail "marker directory fsync failed: $pathname"; return 1; }
}

write_runtime_markers() {
  local commit="$1" pid="$2" pathname expected actual
  atomic_write_marker "$RUNTIME_DIR/RUNNING_COMMIT" "$commit" || return 1
  atomic_write_marker "$RUNTIME_DIR/video-autoworker-3017.pid" "$pid" || return 1
  atomic_write_marker "$RUNTIME_DIR/video-autoworker.pid" "$pid" || return 1
  for pathname in \
    "$RUNTIME_DIR/RUNNING_COMMIT:$commit" \
    "$RUNTIME_DIR/video-autoworker-3017.pid:$pid" \
    "$RUNTIME_DIR/video-autoworker.pid:$pid"; do
    expected="${pathname##*:}"
    pathname="${pathname%:*}"
    assert_private_file "updated runtime marker" "$pathname" || return 1
    actual="$(tr -d '[:space:]' < "$pathname")" \
      || { fail "runtime marker cannot be read: $pathname"; return 1; }
    [[ "$actual" == "$expected" ]] \
      || { fail "runtime marker verification failed: $pathname"; return 1; }
  done
}

probe_release() {
  local label="$1" release_root="$2" log_path="$RUNTIME_DIR/${label// /-}-probe.log" pid
  local listeners probe_database_path
  local probe_database="$PROBE_DATA_DIR/mission-control.db"
  local probe_tokens="$PROBE_DATA_DIR/mission-control-tokens.json"
  listeners="$(listener_pids "$PROBE_PORT")" || return 1
  [[ -z "$listeners" ]] \
    || { fail "probe port $PROBE_PORT is already in use"; return 1; }
  start_release "$release_root" "$PROBE_PORT" "$probe_database" "$probe_tokens" probe "$log_path" \
    || return 1
  pid="$LAST_LAUNCHED_PID"
  probe_database_path="$(physical_path "$PROBE_DATA_DIR/mission-control.db")" || return 1
  if ! wait_and_verify_runtime "$label probe" "$pid" "$release_root" "$PROBE_PORT" \
    "$probe_database_path"; then
    stop_exact_runtime "$label failed probe" "$pid" "$release_root" "$PROBE_PORT" \
      || { fail "$label failed probe could not be stopped safely"; return 1; }
    return 1
  fi
  stop_exact_runtime "$label probe" "$pid" "$release_root" "$PROBE_PORT" || return 1
  listeners="$(listener_pids "$PROBE_PORT")" || return 1
  [[ -z "$listeners" ]] \
    || { fail "$label probe left a listener behind"; return 1; }
}

old_runtime_process_matches() {
  local actual_cwd expected_cwd current_start
  [[ "$old_pid" =~ ^[1-9][0-9]*$ && -n "$old_process_start" ]] || return 1
  kill -0 "$old_pid" 2>/dev/null || return 1
  expected_cwd="$(physical_path "$(release_standalone_root "$OLD_RELEASE_ROOT")")" \
    || return 1
  actual_cwd="$(process_cwd "$old_pid")" || return 1
  [[ "$actual_cwd" == "$expected_cwd" ]] || return 1
  current_start="$(process_start_identity "$old_pid")" || return 1
  [[ "$current_start" == "$old_process_start" ]] || return 1
  process_has_database "$old_pid" "$LIVE_DB_PATH" || return 1
}

old_runtime_still_live() {
  local listener
  old_runtime_process_matches || return 1
  listener="$(listener_pids "$PORT")" || return 1
  [[ "$listener" == "$old_pid" ]]
}

database_holder_pids() {
  local output status=0
  output="$("$LSOF_BIN" -nP -t -- "$1" 2>&1)" || status=$?
  if (( status == 0 )); then
    printf '%s\n' "$output" | sed '/^$/d' | sort -u || return 1
    return
  fi
  if (( status == 1 )) && [[ -z "$output" ]]; then
    return 0
  fi
  fail "live database holders cannot be inspected"
  return 1
}

assert_no_live_database_holders() {
  local holders holder
  holders="$(database_holder_pids "$LIVE_DB_PATH")" || return 1
  while IFS= read -r holder; do
    [[ -z "$holder" ]] && continue
    [[ "$holder" =~ ^[1-9][0-9]*$ ]] \
      || { fail "live database holder list is invalid"; return 1; }
    fail "cannot restore legacy runtime while the live database has an existing holder"
    return 1
  done <<< "$holders"
}

rollback_live() {
  local rollback_pid rollback_start listeners
  if [[ -n "$new_pid" ]] && kill -0 "$new_pid" 2>/dev/null; then
    stop_exact_runtime "$FAILED_TARGET_LABEL" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" || return 1
  fi
  assert_live_database_unchanged || return 1
  assert_live_tokens_safe_for_rollback || return 1
  if (( old_stop_requested == 0 )) && old_runtime_still_live; then
    write_runtime_markers "$OLD_COMMIT" "$old_pid" || return 1
    assert_live_database_unchanged || return 1
    assert_live_tokens_safe_for_rollback || return 1
    assert_protected_unchanged || return 1
    printf '3017 source release %s remained active with PID %s\n' "$OLD_COMMIT" "$old_pid" >&2 \
      || return 1
    return 0
  fi
  if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    old_runtime_process_matches \
      || { fail "cannot restore legacy runtime while the original PID identity is unknown"; return 1; }
    stop_exact_runtime "$PARTIAL_SOURCE_LABEL" "$old_pid" "$OLD_RELEASE_ROOT" \
      "$PORT" "$old_process_start" || return 1
  fi
  assert_no_live_database_holders || return 1
  listeners="$(listener_pids "$PORT")" || return 1
  [[ -z "$listeners" ]] \
    || { fail "cannot restore legacy runtime while port $PORT is occupied"; return 1; }
  start_release "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" "$LIVE_TOKENS_PATH" live \
    "$RUNTIME_DIR/video-autoworker-3017-rollback.log" || return 1
  rollback_pid="$LAST_LAUNCHED_PID"
  wait_and_verify_runtime "$RESTORED_SOURCE_LABEL" "$rollback_pid" "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" \
    || return 1
  rollback_start="$(process_start_identity "$rollback_pid")" \
    || { fail "restored legacy process start identity cannot be read"; return 1; }
  [[ -n "$rollback_start" ]] \
    || { fail "restored legacy process start identity is unavailable"; return 1; }
  assert_live_database_unchanged || return 1
  assert_live_tokens_safe_for_rollback || return 1
  write_runtime_markers "$OLD_COMMIT" "$rollback_pid" || return 1
  assert_protected_unchanged || return 1
  printf 'Restored 3017 source release %s with PID %s\n' "$OLD_COMMIT" "$rollback_pid" >&2 \
    || return 1
}

on_exit() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  if (( transition_started == 1 && switch_complete == 0 )); then
    if ! rollback_live; then
      printf 'CRITICAL: automatic legacy 3017 restoration failed\n' >&2
      exit 90
    fi
  fi
  exit "$status"
}

on_signal() {
  exit 130
}

perform_live_switch() {
  local candidate_start listeners
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  transition_started=1
  old_stop_requested=1
  stop_exact_runtime "$SOURCE_RUNTIME_LABEL" "$old_pid" "$OLD_RELEASE_ROOT" "$PORT" "$old_process_start" \
    || return 1
  listeners="$(listener_pids "$PORT")" || return 1
  [[ -z "$listeners" ]] \
    || { fail "port $PORT did not become free"; return 1; }
  start_release "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" "$LIVE_TOKENS_PATH" live \
    "$RUNTIME_DIR/video-autoworker-3017-${NEW_COMMIT:0:7}.log" || return 1
  new_pid="$LAST_LAUNCHED_PID"
  wait_and_verify_runtime "$TARGET_RUNTIME_LABEL" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" \
    || return 1
  candidate_start="$(process_start_identity "$new_pid")" || return 1
  [[ -n "$candidate_start" ]] \
    || { fail "candidate process start identity is unavailable"; return 1; }
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  assert_protected_unchanged || return 1
  write_runtime_markers "$NEW_COMMIT" "$new_pid" || return 1
  assert_runtime_identity "committed target runtime" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" \
    || return 1
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  assert_protected_unchanged || return 1
  switch_complete=1
  printf 'Switched only 3017 %s to %s with PID %s\n' "$SWITCH_DIRECTION" "$NEW_COMMIT" "$new_pid"
}

configure_directional_roles() {
  local fixed_old_root fixed_old_commit
  if (( ROLLBACK == 0 )); then
    return 0
  fi
  fixed_old_root="$OLD_RELEASE_ROOT"
  fixed_old_commit="$OLD_COMMIT"
  OLD_RELEASE_ROOT="$NEW_RELEASE_ROOT"
  OLD_COMMIT="$NEW_COMMIT"
  NEW_RELEASE_ROOT="$fixed_old_root"
  NEW_COMMIT="$fixed_old_commit"
  SWITCH_DIRECTION=rollback
  SOURCE_PROBE_LABEL=current-ui
  TARGET_PROBE_LABEL=legacy-rollback
  SOURCE_RUNTIME_LABEL="current UI runtime"
  TARGET_RUNTIME_LABEL="legacy rollback runtime"
  FAILED_TARGET_LABEL="failed legacy rollback runtime"
  RESTORED_SOURCE_LABEL="restored current UI runtime"
  PARTIAL_SOURCE_LABEL="partially stopping current UI runtime"
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --apply)
        (( APPLY == 0 )) || { usage >&2; fail "duplicate --apply"; return 2; }
        APPLY=1
        shift
        ;;
      --rollback)
        (( ROLLBACK == 0 )) || { usage >&2; fail "duplicate --rollback"; return 2; }
        ROLLBACK=1
        shift
        ;;
      --old-release-root) OLD_RELEASE_ROOT="${2:-}"; shift 2 ;;
      --old-commit) OLD_COMMIT="${2:-}"; shift 2 ;;
      --new-release-root) NEW_RELEASE_ROOT="${2:-}"; shift 2 ;;
      --new-commit) NEW_COMMIT="${2:-}"; shift 2 ;;
      --live-db) LIVE_DB_PATH="${2:-}"; shift 2 ;;
      --live-tokens) LIVE_TOKENS_PATH="${2:-}"; shift 2 ;;
      --probe-data-dir) PROBE_DATA_DIR="${2:-}"; shift 2 ;;
      --source-app-dir) SOURCE_APP_DIR="${2:-}"; shift 2 ;;
      --runtime-dir) RUNTIME_DIR="${2:-}"; shift 2 ;;
      --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      --probe-port) PROBE_PORT="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; fail "unknown or incomplete argument: $1"; exit 2 ;;
    esac
  done
}

main() {
  local probe_database_path
  parse_args "$@" || return 1
  assert_full_commit "old commit" "$OLD_COMMIT" || return 1
  assert_full_commit "new commit" "$NEW_COMMIT" || return 1
  [[ "$OLD_COMMIT" == "$EXPECTED_OLD_COMMIT" ]] \
    || { fail "this bridge accepts only the verified legacy release"; return 1; }
  [[ "$NEW_COMMIT" == "$EXPECTED_NEW_COMMIT" ]] \
    || { fail "this bridge accepts only the verified UI release"; return 1; }
  for pair in \
    "old release root:$OLD_RELEASE_ROOT" \
    "new release root:$NEW_RELEASE_ROOT" \
    "live database:$LIVE_DB_PATH" \
    "live tokens:$LIVE_TOKENS_PATH" \
    "probe data directory:$PROBE_DATA_DIR" \
    "source app directory:$SOURCE_APP_DIR" \
    "runtime directory:$RUNTIME_DIR"; do
    require_absolute "${pair%%:*}" "${pair#*:}" || return 1
  done
  [[ "$PORT" == 3017 ]] \
    || { fail "this bridge may manage only port 3017"; return 1; }
  [[ "$PROBE_PORT" =~ ^[1-9][0-9]*$ && "$PROBE_PORT" != "$PORT" ]] \
    && (( 10#$PROBE_PORT <= 65535 )) \
    || { fail "probe port is invalid"; return 1; }
  resolve_node_bin || return 1
  require_absolute "lsof executable" "$LSOF_BIN" || return 1
  require_absolute "curl executable" "$CURL_BIN" || return 1
  [[ -x "$LSOF_BIN" && -x "$CURL_BIN" ]] \
    || { fail "required system tools are unavailable"; return 1; }
  assert_safe_directory "source app directory" "$SOURCE_APP_DIR" || return 1
  assert_safe_directory "runtime directory" "$RUNTIME_DIR" || return 1
  assert_safe_directory "probe data directory" "$PROBE_DATA_DIR" || return 1
  [[ -f "$LIVE_DB_PATH" && ! -L "$LIVE_DB_PATH" ]] \
    || { fail "live database is unavailable or unsafe"; return 1; }
  [[ -f "$PROBE_DATA_DIR/mission-control.db" && ! -L "$PROBE_DATA_DIR/mission-control.db" ]] \
    || { fail "probe database snapshot is unavailable or unsafe"; return 1; }
  LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")" || return 1
  prepare_live_database_contract || return 1
  prepare_live_tokens_contract || return 1
  probe_database_path="$(physical_path "$PROBE_DATA_DIR/mission-control.db")" || return 1
  [[ "$probe_database_path" != "$LIVE_DB_PATH" ]] \
    || { fail "probe database must not be the live database"; return 1; }
  assert_release "legacy release" "$OLD_RELEASE_ROOT" "$OLD_COMMIT" || return 1
  assert_release "candidate release" "$NEW_RELEASE_ROOT" "$NEW_COMMIT" || return 1
  assert_ui_only_diff || return 1
  configure_directional_roles || return 1
  assert_live_source_identity || return 1
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  protected_before="$(capture_protected_listeners)" || return 1
  assert_live_database_unchanged || return 1
  probe_release "$SOURCE_PROBE_LABEL" "$OLD_RELEASE_ROOT" || return 1
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  probe_release "$TARGET_PROBE_LABEL" "$NEW_RELEASE_ROOT" || return 1
  assert_live_source_identity || return 1
  assert_live_database_unchanged || return 1
  assert_live_tokens_unchanged || return 1
  assert_protected_unchanged || return 1
  if (( APPLY == 0 )); then
    printf '3017 %s preflight passed; live runtime was not changed\n' "$SWITCH_DIRECTION"
    return
  fi
  trap on_exit EXIT
  trap on_signal INT TERM HUP
  perform_live_switch || return 1
  trap - EXIT INT TERM HUP
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
