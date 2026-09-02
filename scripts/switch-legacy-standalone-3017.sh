#!/usr/bin/env bash

set -euo pipefail
umask 077

# One-time bridge for a legacy single-process 3017 release. It deliberately
# does not build code, run database tooling, import n8n workflows, or manage any
# service other than the exact 3017 PID supplied by current runtime evidence.

PORT=3017
PROBE_PORT=3018
APPLY=0
EXPECTED_OLD_COMMIT=542eebdd871f0d960d972e879310bec7a3d15cca
EXPECTED_NEW_COMMIT=d3ca02ecdcbffb778c9c65d540e1095bffea7138
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
PROTECTED_PORTS="${AIWORKER_LEGACY_SWITCH_PROTECTED_PORTS:-5678 5679 18789 18889 18989 18091 18094 11434}"

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

usage() {
  cat <<'EOF'
Usage: switch-legacy-standalone-3017.sh [--apply] \
  --old-release-root ABS --old-commit FULL_SHA \
  --new-release-root ABS --new-commit FULL_SHA \
  --live-db ABS --live-tokens ABS --probe-data-dir ABS \
  --source-app-dir ABS --runtime-dir ABS [--node-bin ABS]

Without --apply the script performs the full identity, rollback-start and
candidate-start preflight, then exits without stopping the live 3017 process.
The probe directory must already contain a non-production mission-control.db.
EOF
}

fail() {
  printf 'legacy 3017 switch failed: %s\n' "$*" >&2
  return 1
}

require_absolute() {
  [[ "$2" == /* && "$2" != *[$'\r\n']* ]] || fail "$1 must be one absolute path"
}

physical_path() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' "$1"
}

resolve_node_bin() {
  if [[ "$NODE_BIN" != /* ]]; then
    [[ "$NODE_BIN" != */* && "$NODE_BIN" =~ ^[A-Za-z0-9._+-]+$ ]] \
      || fail "Node executable must be an absolute path or one command name"
    NODE_BIN="$(command -v "$NODE_BIN")" || fail "Node executable is unavailable"
  fi
  require_absolute "Node executable" "$NODE_BIN"
  [[ -x "$NODE_BIN" ]] || fail "Node executable is unavailable"
}

assert_private_file() {
  local label="$1" pathname="$2" mode
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] || fail "$label is missing or unsafe"
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  [[ "$mode" == 600 ]] || fail "$label must have mode 0600"
}

assert_safe_directory() {
  local label="$1" pathname="$2" mode
  [[ -d "$pathname" && ! -L "$pathname" && -O "$pathname" ]] || fail "$label is missing or unsafe"
  mode="$(stat -f '%Lp' "$pathname" 2>/dev/null || stat -c '%a' "$pathname")"
  (( (8#$mode & 8#022) == 0 )) || fail "$label is group/other writable"
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
  local expected_default parent first second
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

  expected_default="$(dirname "$LIVE_DB_PATH")/mission-control-tokens.json"
  [[ "$LIVE_TOKENS_PATH" == "$expected_default" ]] \
    || { fail "missing live tokens is allowed only at the data directory default path"; return 1; }
  [[ ! -L "$LIVE_TOKENS_PATH" ]] \
    || { fail "missing live tokens path must not be a symlink"; return 1; }
  parent="$(dirname "$LIVE_TOKENS_PATH")"
  assert_safe_directory "live tokens parent directory" "$parent" || return 1
  [[ "$(physical_path "$parent")" == "$parent" ]] \
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
  [[ "$2" =~ ^[a-f0-9]{40}$ ]] || fail "$1 must be one full Git commit"
}

release_standalone_root() {
  printf '%s/.next/standalone\n' "$1"
}

assert_release() {
  local label="$1" release_root="$2" expected_commit="$3" actual standalone
  assert_safe_directory "$label" "$release_root"
  actual="$(/usr/bin/git -C "$release_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || fail "$label is not a Git worktree"
  [[ "$actual" == "$expected_commit" ]] || fail "$label commit does not match"
  /usr/bin/git -C "$release_root" diff --quiet --ignore-submodules -- \
    || fail "$label has tracked worktree changes"
  /usr/bin/git -C "$release_root" diff --cached --quiet --ignore-submodules -- \
    || fail "$label has staged changes"
  standalone="$(release_standalone_root "$release_root")"
  [[ -d "$standalone" && ! -L "$standalone" && -f "$standalone/server.js" \
    && ! -L "$standalone/server.js" ]] || fail "$label standalone server is unavailable"
  [[ -d "$standalone/.next/static" && -d "$standalone/public" ]] \
    || fail "$label static/public assets are not assembled"
  if find "$release_root" -name .PhoenixBrain -print -quit 2>/dev/null | grep -q .; then
    fail "$label contains private .PhoenixBrain routing metadata"
  fi
}

assert_ui_only_diff() {
  local path changed_paths
  /usr/bin/git -C "$SOURCE_APP_DIR" merge-base --is-ancestor "$OLD_COMMIT" "$NEW_COMMIT" \
    || fail "new release is not a descendant of the old release"
  changed_paths="$(/usr/bin/git -C "$SOURCE_APP_DIR" diff --name-only "$OLD_COMMIT..$NEW_COMMIT")" \
    || fail "release diff cannot be read"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      docs/*|tests/*|src/lib/__tests__/*|src/components/panels/*|src/components/ui/*|\
      package.json|pnpm-lock.yaml|tailwind.config.js|\
      scripts/install-aiworker-video-lane-supervisor.sh) ;;
      *) fail "release diff is not 3017 UI-only: $path" ;;
    esac
  done <<< "$changed_paths"

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
      || fail "runtime contract changed: $path"
  done
}

listener_pids() {
  { "$LSOF_BIN" -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | sort -u
}

single_listener_pid() {
  local values count
  values="$(listener_pids "$1")"
  count="$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  [[ "$count" == 1 ]] || fail "port $1 does not have exactly one listener"
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
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "$label PID is invalid"
  kill -0 "$pid" 2>/dev/null || fail "$label PID is not running"
  expected_cwd="$(physical_path "$(release_standalone_root "$release_root")")" \
    || fail "$label standalone cwd cannot be resolved"
  actual_cwd="$(process_cwd "$pid")"
  [[ "$actual_cwd" == "$expected_cwd" ]] || fail "$label cwd does not match its release"
  listener="$(single_listener_pid "$port")" || return 1
  [[ "$listener" == "$pid" ]] || fail "$label does not own port $port"
  process_has_database "$pid" "$database" || fail "$label does not hold the expected database FD"
}

assert_live_legacy_identity() {
  local recorded
  old_pid="$(single_listener_pid "$PORT")" || return 1
  assert_runtime_identity "legacy runtime" "$old_pid" "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH"
  old_process_start="$(process_start_identity "$old_pid")"
  [[ -n "$old_process_start" ]] || fail "legacy process start identity is unavailable"
  for pathname in "$RUNTIME_DIR/video-autoworker-3017.pid" "$RUNTIME_DIR/video-autoworker.pid"; do
    assert_private_file "legacy PID marker" "$pathname"
    recorded="$(tr -d '[:space:]' < "$pathname")"
    [[ "$recorded" == "$old_pid" ]] || fail "legacy PID marker does not match the listener"
  done
  assert_private_file "RUNNING_COMMIT" "$RUNTIME_DIR/RUNNING_COMMIT"
  recorded="$(tr -d '[:space:]' < "$RUNTIME_DIR/RUNNING_COMMIT")"
  [[ "$recorded" == "$OLD_COMMIT" ]] || fail "RUNNING_COMMIT does not identify the legacy release"
}

capture_protected_listeners() {
  local port values
  for port in $PROTECTED_PORTS; do
    [[ "$port" =~ ^[1-9][0-9]*$ ]] && (( 10#$port <= 65535 )) \
      || fail "protected port list is invalid"
    values="$(listener_pids "$port" | tr '\n' ',' | sed 's/,$//')"
    printf '%s=%s\n' "$port" "$values"
  done
}

assert_protected_unchanged() {
  local after
  after="$(capture_protected_listeners)" || return 1
  [[ "$after" == "$protected_before" ]] || fail "a protected listener changed during the 3017 switch"
}

load_env_file() {
  local pathname="$1"
  [[ -e "$pathname" || -L "$pathname" ]] || return 0
  [[ -f "$pathname" && ! -L "$pathname" && -O "$pathname" ]] \
    || fail "refusing unsafe environment file: $pathname"
  set -a
  # shellcheck disable=SC1090
  source "$pathname"
  set +a
}

start_release() {
  local release_root="$1" port="$2" database="$3" tokens="$4" mode="$5" log_path="$6"
  local standalone data_dir
  standalone="$(release_standalone_root "$release_root")"
  data_dir="$(dirname "$database")"
  (
    load_env_file "$SOURCE_APP_DIR/.env"
    load_env_file "$SOURCE_APP_DIR/.env.local"
    load_env_file "$PLATFORM_ENV_FILE"
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
    cd "$standalone"
    exec "$NODE_BIN" server.js
  ) >>"$log_path" 2>&1 &
  LAST_LAUNCHED_PID=$!
}

wait_and_verify_runtime() {
  local label="$1" pid="$2" release_root="$3" port="$4" database="$5" attempt
  for attempt in $(seq 1 80); do
    if kill -0 "$pid" 2>/dev/null \
      && "$CURL_BIN" -fsS --max-time 2 "http://127.0.0.1:$port/api/status?action=health" >/dev/null 2>&1; then
      assert_runtime_identity "$label" "$pid" "$release_root" "$port" "$database"
      return
    fi
    sleep 0.25
  done
  fail "$label did not become healthy"
}

stop_exact_runtime() {
  local label="$1" pid="$2" release_root="$3" port="$4" expected_start="${5:-}" attempt current_start cwd
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "$label PID is invalid"
  kill -0 "$pid" 2>/dev/null || return 0
  cwd="$(process_cwd "$pid")"
  [[ "$cwd" == "$(physical_path "$(release_standalone_root "$release_root")")" ]] \
    || fail "$label PID identity changed before stop"
  if [[ -n "$expected_start" ]]; then
    current_start="$(process_start_identity "$pid")"
    [[ "$current_start" == "$expected_start" ]] || fail "$label PID was reused before stop"
  fi
  if [[ -n "$(listener_pids "$port")" ]]; then
    [[ "$(single_listener_pid "$port")" == "$pid" ]] || fail "$label no longer uniquely owns port $port"
  fi
  kill "$pid"
  for attempt in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  cwd="$(process_cwd "$pid")"
  current_start="$(process_start_identity "$pid")"
  [[ "$cwd" == "$(physical_path "$(release_standalone_root "$release_root")")" \
    && ( -z "$expected_start" || "$current_start" == "$expected_start" ) ]] \
    || fail "$label identity changed before SIGKILL"
  kill -9 "$pid"
  for attempt in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  fail "$label did not stop"
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
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail "marker temporary path already exists"
  if printf '%s\n' "$value" > "$temporary" \
    && chmod 600 "$temporary" \
    && fsync_path "$temporary" \
    && mv -f "$temporary" "$pathname" \
    && fsync_path "$RUNTIME_DIR"; then
    return
  fi
  /bin/rm -f -- "$temporary"
  fail "marker update failed: $pathname"
}

write_runtime_markers() {
  local commit="$1" pid="$2" pathname expected actual
  atomic_write_marker "$RUNTIME_DIR/RUNNING_COMMIT" "$commit"
  atomic_write_marker "$RUNTIME_DIR/video-autoworker-3017.pid" "$pid"
  atomic_write_marker "$RUNTIME_DIR/video-autoworker.pid" "$pid"
  for pathname in \
    "$RUNTIME_DIR/RUNNING_COMMIT:$commit" \
    "$RUNTIME_DIR/video-autoworker-3017.pid:$pid" \
    "$RUNTIME_DIR/video-autoworker.pid:$pid"; do
    expected="${pathname##*:}"
    pathname="${pathname%:*}"
    assert_private_file "updated runtime marker" "$pathname"
    actual="$(tr -d '[:space:]' < "$pathname")"
    [[ "$actual" == "$expected" ]] || fail "runtime marker verification failed: $pathname"
  done
}

probe_release() {
  local label="$1" release_root="$2" log_path="$RUNTIME_DIR/${label// /-}-probe.log" pid
  local probe_database="$PROBE_DATA_DIR/mission-control.db"
  local probe_tokens="$PROBE_DATA_DIR/mission-control-tokens.json"
  [[ -z "$(listener_pids "$PROBE_PORT")" ]] || fail "probe port $PROBE_PORT is already in use"
  start_release "$release_root" "$PROBE_PORT" "$probe_database" "$probe_tokens" probe "$log_path"
  pid="$LAST_LAUNCHED_PID"
  if ! wait_and_verify_runtime "$label probe" "$pid" "$release_root" "$PROBE_PORT" \
    "$(physical_path "$PROBE_DATA_DIR/mission-control.db")"; then
    stop_exact_runtime "$label failed probe" "$pid" "$release_root" "$PROBE_PORT" || true
    return 1
  fi
  stop_exact_runtime "$label probe" "$pid" "$release_root" "$PROBE_PORT"
  [[ -z "$(listener_pids "$PROBE_PORT")" ]] || fail "$label probe left a listener behind"
}

old_runtime_still_live() {
  local listener actual_cwd expected_cwd current_start
  [[ "$old_pid" =~ ^[1-9][0-9]*$ && -n "$old_process_start" ]] || return 1
  kill -0 "$old_pid" 2>/dev/null || return 1
  listener="$(listener_pids "$PORT")"
  [[ "$listener" == "$old_pid" ]] || return 1
  expected_cwd="$(physical_path "$(release_standalone_root "$OLD_RELEASE_ROOT")")" \
    || return 1
  actual_cwd="$(process_cwd "$old_pid")"
  [[ "$actual_cwd" == "$expected_cwd" ]] || return 1
  current_start="$(process_start_identity "$old_pid")"
  [[ "$current_start" == "$old_process_start" ]] || return 1
  process_has_database "$old_pid" "$LIVE_DB_PATH" || return 1
}

rollback_live() {
  local rollback_pid rollback_start
  if [[ -n "$new_pid" ]] && kill -0 "$new_pid" 2>/dev/null; then
    stop_exact_runtime "failed candidate runtime" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" || return 1
  fi
  assert_live_database_unchanged || return 1
  assert_live_tokens_safe_for_rollback || return 1
  if (( old_stop_requested == 0 )) && old_runtime_still_live; then
    write_runtime_markers "$OLD_COMMIT" "$old_pid" || return 1
    assert_live_database_unchanged || return 1
    assert_live_tokens_safe_for_rollback || return 1
    assert_protected_unchanged || return 1
    printf 'Legacy 3017 release %s remained active with PID %s\n' "$OLD_COMMIT" "$old_pid" >&2
    return
  fi
  if (( old_stop_requested == 1 )) && old_runtime_still_live; then
    stop_exact_runtime "partially stopping legacy runtime" "$old_pid" "$OLD_RELEASE_ROOT" \
      "$PORT" "$old_process_start" || return 1
  fi
  [[ -z "$(listener_pids "$PORT")" ]] \
    || { fail "cannot restore legacy runtime while port $PORT is occupied"; return 1; }
  start_release "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" "$LIVE_TOKENS_PATH" live \
    "$RUNTIME_DIR/video-autoworker-3017-rollback.log"
  rollback_pid="$LAST_LAUNCHED_PID"
  wait_and_verify_runtime "restored legacy runtime" "$rollback_pid" "$OLD_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" \
    || return 1
  rollback_start="$(process_start_identity "$rollback_pid")"
  [[ -n "$rollback_start" ]] || return 1
  assert_live_database_unchanged || return 1
  assert_live_tokens_safe_for_rollback || return 1
  write_runtime_markers "$OLD_COMMIT" "$rollback_pid" || return 1
  assert_protected_unchanged || return 1
  printf 'Restored legacy 3017 release %s with PID %s\n' "$OLD_COMMIT" "$rollback_pid" >&2
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
  local candidate_start
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  transition_started=1
  old_stop_requested=1
  stop_exact_runtime "legacy runtime" "$old_pid" "$OLD_RELEASE_ROOT" "$PORT" "$old_process_start"
  [[ -z "$(listener_pids "$PORT")" ]] || fail "port $PORT did not become free"
  start_release "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH" "$LIVE_TOKENS_PATH" live \
    "$RUNTIME_DIR/video-autoworker-3017-${NEW_COMMIT:0:7}.log"
  new_pid="$LAST_LAUNCHED_PID"
  wait_and_verify_runtime "candidate runtime" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH"
  candidate_start="$(process_start_identity "$new_pid")"
  [[ -n "$candidate_start" ]] || fail "candidate process start identity is unavailable"
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  assert_protected_unchanged
  write_runtime_markers "$NEW_COMMIT" "$new_pid"
  assert_runtime_identity "committed candidate runtime" "$new_pid" "$NEW_RELEASE_ROOT" "$PORT" "$LIVE_DB_PATH"
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  assert_protected_unchanged
  switch_complete=1
  printf 'Switched only 3017 to %s with PID %s\n' "$NEW_COMMIT" "$new_pid"
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --apply) APPLY=1; shift ;;
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
  parse_args "$@"
  assert_full_commit "old commit" "$OLD_COMMIT"
  assert_full_commit "new commit" "$NEW_COMMIT"
  [[ "$OLD_COMMIT" == "$EXPECTED_OLD_COMMIT" ]] \
    || fail "this bridge accepts only the verified legacy release"
  [[ "$NEW_COMMIT" == "$EXPECTED_NEW_COMMIT" ]] \
    || fail "this bridge accepts only the verified UI release"
  for pair in \
    "old release root:$OLD_RELEASE_ROOT" \
    "new release root:$NEW_RELEASE_ROOT" \
    "live database:$LIVE_DB_PATH" \
    "live tokens:$LIVE_TOKENS_PATH" \
    "probe data directory:$PROBE_DATA_DIR" \
    "source app directory:$SOURCE_APP_DIR" \
    "runtime directory:$RUNTIME_DIR"; do
    require_absolute "${pair%%:*}" "${pair#*:}"
  done
  [[ "$PORT" == 3017 ]] || fail "this bridge may manage only port 3017"
  [[ "$PROBE_PORT" =~ ^[1-9][0-9]*$ && "$PROBE_PORT" != "$PORT" ]] \
    && (( 10#$PROBE_PORT <= 65535 )) \
    || fail "probe port is invalid"
  resolve_node_bin
  require_absolute "lsof executable" "$LSOF_BIN"
  require_absolute "curl executable" "$CURL_BIN"
  [[ -x "$LSOF_BIN" && -x "$CURL_BIN" ]] || fail "required system tools are unavailable"
  assert_safe_directory "source app directory" "$SOURCE_APP_DIR"
  assert_safe_directory "runtime directory" "$RUNTIME_DIR"
  assert_safe_directory "probe data directory" "$PROBE_DATA_DIR"
  [[ -f "$LIVE_DB_PATH" && ! -L "$LIVE_DB_PATH" ]] || fail "live database is unavailable or unsafe"
  [[ -f "$PROBE_DATA_DIR/mission-control.db" && ! -L "$PROBE_DATA_DIR/mission-control.db" ]] \
    || fail "probe database snapshot is unavailable or unsafe"
  LIVE_DB_PATH="$(physical_path "$LIVE_DB_PATH")"
  prepare_live_database_contract
  prepare_live_tokens_contract
  [[ "$(physical_path "$PROBE_DATA_DIR/mission-control.db")" != "$LIVE_DB_PATH" ]] \
    || fail "probe database must not be the live database"
  assert_release "legacy release" "$OLD_RELEASE_ROOT" "$OLD_COMMIT"
  assert_release "candidate release" "$NEW_RELEASE_ROOT" "$NEW_COMMIT"
  assert_ui_only_diff
  assert_live_legacy_identity
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  protected_before="$(capture_protected_listeners)"
  assert_live_database_unchanged
  probe_release "legacy-rollback" "$OLD_RELEASE_ROOT"
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  probe_release "candidate" "$NEW_RELEASE_ROOT"
  assert_live_legacy_identity
  assert_live_database_unchanged
  assert_live_tokens_unchanged
  assert_protected_unchanged
  if (( APPLY == 0 )); then
    printf 'Legacy 3017 switch preflight passed; live runtime was not changed\n'
    return
  fi
  trap on_exit EXIT
  trap on_signal INT TERM HUP
  perform_live_switch
  trap - EXIT INT TERM HUP
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
